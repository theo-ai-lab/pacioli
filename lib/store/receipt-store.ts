/**
 * Pacioli — receipt store (durable persistence for the API/backend), ZERO npm dependency.
 *
 * The API writes each reconciliation here; /api/metrics reads it. Backed by the BUILT-IN `node:sqlite`
 * (Node 22.5+) when a DB path is configured (PACIOLI_DB), else an in-memory fallback — so it works
 * everywhere with no Prisma/Postgres/Redis. Swap in a hosted DB later by implementing ReceiptStore.
 */

export interface StoredReceipt {
  receiptId: string;
  receiptHash: string;
  balanced: boolean;
  findingTypes: string[];
  agent: string;
  merchant: string;
  deltaUsd: number | null;
  createdAt: number;
  /** STORE-MANAGED: how many times this content-addressed receipt has been recorded. Receipts are
   *  idempotent by content (replaying identical claim+evidence IS the same receipt), but each replay
   *  still counts as an event — otherwise the metrics counter would silently collapse repeats. */
  seenCount?: number;
}

export interface StoreStats {
  /** Unique content-addressed receipts. */
  total: number;
  /** Total recorded events (sum of seenCount) — the honest monotonic counter. */
  events: number;
  flagged: number;
  byType: Record<string, number>;
}

export interface ReceiptStore {
  backend: "sqlite" | "memory";
  save(r: StoredReceipt): void;
  get(id: string): StoredReceipt | null;
  list(limit?: number): StoredReceipt[];
  stats(): StoreStats;
}

function computeStats(rows: StoredReceipt[]): StoreStats {
  const byType: Record<string, number> = {};
  let flagged = 0;
  let events = 0;
  for (const r of rows) {
    events += r.seenCount ?? 1;
    if (!r.balanced) flagged++;
    for (const t of r.findingTypes) byType[t] = (byType[t] ?? 0) + 1;
  }
  return { total: rows.length, events, flagged, byType };
}

/** Bound the in-memory fallback so an unauthenticated POST flood can't grow memory without limit. */
const MEMORY_CAP = 10_000;
/** Same flood rationale, durable backend: cap sqlite rows too (a unique-payload flood would
 *  otherwise grow the DB file without bound). Oldest receipts are pruned past the cap. */
const SQLITE_CAP = 50_000;

export function createMemoryStore(): ReceiptStore {
  const rows: StoredReceipt[] = [];
  return {
    backend: "memory",
    save: (r) => {
      const existing = rows.find((x) => x.receiptId === r.receiptId);
      if (existing) {
        existing.seenCount = (existing.seenCount ?? 1) + 1; // replay of the same content-addressed receipt
        return;
      }
      rows.push({ ...r, seenCount: 1 });
      if (rows.length > MEMORY_CAP) rows.splice(0, rows.length - MEMORY_CAP);
    },
    get: (id) => rows.find((r) => r.receiptId === id) ?? null,
    list: (limit = 100) => rows.slice(-limit).reverse(),
    stats: () => computeStats(rows),
  };
}

// `node:sqlite` is a Node built-in; the variable specifier keeps the typechecker from requiring types
// for it (we wrap it in a minimal local interface instead).
const NODE_SQLITE = "node:sqlite";
interface SqliteStmt {
  run(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  get(...a: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

const toRow = (o: Record<string, unknown>): StoredReceipt => ({
  receiptId: String(o.receiptId),
  receiptHash: String(o.receiptHash),
  balanced: o.balanced === 1,
  findingTypes: o.findingTypes ? String(o.findingTypes).split(",").filter(Boolean) : [],
  agent: String(o.agent),
  merchant: String(o.merchant),
  deltaUsd: o.deltaUsd === null || o.deltaUsd === undefined ? null : Number(o.deltaUsd),
  createdAt: Number(o.createdAt),
  seenCount: Number(o.seenCount ?? 1),
});

/** Build a node:sqlite-backed store, or null if the runtime/module isn't available. */
export async function tryCreateSqliteStore(path: string): Promise<ReceiptStore | null> {
  try {
    const mod = (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => SqliteDb };
    const db = new mod.DatabaseSync(path);
    db.exec(
      `CREATE TABLE IF NOT EXISTS receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    const trim = db.prepare(
      `DELETE FROM receipts WHERE rowid IN (
         SELECT rowid FROM receipts ORDER BY createdAt ASC, rowid ASC
         LIMIT (SELECT CASE WHEN COUNT(*) > ${SQLITE_CAP} THEN COUNT(*) - ${SQLITE_CAP} ELSE 0 END FROM receipts))`,
    );
    return {
      backend: "sqlite",
      // Content-addressed upsert: a replay of the same receipt bumps seenCount (the event counter)
      // and keeps the FIRST createdAt — an audit log records when something was first seen.
      save: (r) => {
        db.prepare(
          `INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,1)
           ON CONFLICT(receiptId) DO UPDATE SET seenCount = seenCount + 1`,
        ).run(r.receiptId, r.receiptHash, r.balanced ? 1 : 0, r.findingTypes.join(","), r.agent, r.merchant, r.deltaUsd, r.createdAt);
        trim.run(); // bounded retention — prunes oldest rows past SQLITE_CAP
      },
      get: (id) => {
        const o = db.prepare(`SELECT * FROM receipts WHERE receiptId = ?`).get(id) as Record<string, unknown> | undefined;
        return o ? toRow(o) : null;
      },
      list: (limit = 100) =>
        (db.prepare(`SELECT * FROM receipts ORDER BY createdAt DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map(toRow),
      stats: () => {
        // Narrow projection — stats only needs three columns, not every row hauled through toRow().
        const rows = db.prepare(`SELECT balanced, findingTypes, seenCount FROM receipts`).all() as Record<string, unknown>[];
        const byType: Record<string, number> = {};
        let flagged = 0;
        let events = 0;
        for (const o of rows) {
          events += Number(o.seenCount ?? 1);
          if (o.balanced !== 1) flagged++;
          if (o.findingTypes) for (const t of String(o.findingTypes).split(",").filter(Boolean)) byType[t] = (byType[t] ?? 0) + 1;
        }
        return { total: rows.length, events, flagged, byType };
      },
    };
  } catch {
    return null;
  }
}

let cached: Promise<ReceiptStore> | null = null;

/** The process-wide store: node:sqlite if PACIOLI_DB is set and supported, else in-memory. */
export function getStore(): Promise<ReceiptStore> {
  if (!cached) {
    cached = (async () => {
      const path = process.env.PACIOLI_DB;
      if (path) {
        const s = await tryCreateSqliteStore(path);
        if (s) return s;
        // An operator who set PACIOLI_DB believes receipts persist — a silent downgrade to the
        // in-memory store would be a durability lie. Warn loudly; /api/metrics also exposes `backend`.
        console.warn(
          `[pacioli] PACIOLI_DB=${path} is set but node:sqlite could not be initialized ` +
            `(requires Node >= 22.5 and a writable path) — falling back to a NON-DURABLE in-memory store`,
        );
      }
      return createMemoryStore();
    })();
  }
  return cached;
}
