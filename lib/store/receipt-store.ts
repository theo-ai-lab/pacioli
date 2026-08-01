/**
 * Pacioli — receipt store (durable persistence for the API/backend), ZERO npm dependency.
 *
 * The API writes each reconciliation here; /api/metrics reads it. Backed by the BUILT-IN `node:sqlite`
 * (Node 22.5+) when a DB path is configured (PACIOLI_DB), else an in-memory fallback — so it works
 * everywhere with no Prisma/Postgres/Redis. Swap in a hosted DB later by implementing ReceiptStore.
 *
 * The DURABLE backend is a hash chain, not just a table: every row carries leafHash/prevHash/entryHash
 * and every scope (the store, plus each session ledger) carries a committed count, head and Merkle
 * root, so an edit, delete, reorder or truncation made straight against the sqlite file is detectable
 * — see lib/store/ledger-chain.ts and `npm run verify:ledger -- <db>`.
 */
import { GENESIS, WHOLE_STORE, leafHash, entryHashFor, scopeRoot, shouldReseal } from "./ledger-chain";

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
  /** OPTIONAL per-user/session partition key (additive). When set, the receipt also belongs to a
   *  caller-scoped ledger queryable via listBySession/statsBySession. Untrusted; treated only as an
   *  opaque, parameter-bound value (never interpolated into SQL). Omitted = the shared global ledger. */
  sessionKey?: string;
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
  /** Record a receipt. ASYNC because the durable backend extends a hash chain over the row (Web
   *  Crypto is promise-based) — and because a caller that is told "stored" deserves to have waited
   *  for the write. REJECTS if the receipt could not be persisted; never resolves on a failed write. */
  save(r: StoredReceipt): Promise<void>;
  get(id: string): StoredReceipt | null;
  list(limit?: number): StoredReceipt[];
  stats(): StoreStats;
  /** ADDITIVE: the most recent receipts recorded under a session/user key, newest first. The
   *  per-user ledger surface (/api/ledger?session=…) reads this. Empty for an unknown key. */
  listBySession(sessionKey: string, limit?: number): StoredReceipt[];
  /** ADDITIVE: the same aggregate as stats(), scoped to one session/user key. */
  statsBySession(sessionKey: string): StoreStats;
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
    // NOT chained: the in-memory fallback is explicitly non-durable (see getStore's warning and the
    // `backend` field on /api/metrics). Tamper evidence is a property of the persisted ledger — a
    // chain over rows that vanish on restart would be theatre. `async` only to match the interface.
    save: async (r) => {
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
    listBySession: (sessionKey, limit = 100) =>
      rows
        .filter((r) => r.sessionKey === sessionKey)
        .slice(-limit)
        .reverse(),
    statsBySession: (sessionKey) => computeStats(rows.filter((r) => r.sessionKey === sessionKey)),
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
  sessionKey: o.sessionKey === null || o.sessionKey === undefined ? undefined : String(o.sessionKey),
});

/** Build a node:sqlite-backed store, or null if the runtime/module isn't available.
 *  `cap` overrides the row-retention ceiling (tests use a small one to exercise pruning). */
export async function tryCreateSqliteStore(path: string, opts: { cap?: number } = {}): Promise<ReceiptStore | null> {
  const cap = opts.cap ?? SQLITE_CAP;
  try {
    const mod = (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => SqliteDb };
    const db = new mod.DatabaseSync(path);
    db.exec(
      `CREATE TABLE IF NOT EXISTS receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    // ADDITIVE MIGRATIONS: a DB created before per-session support has no sessionKey column, and one
    // created before the hash chain has no chain columns. CREATE TABLE IF NOT EXISTS won't add either,
    // so add them idempotently. The partial index keeps the session-scoped reads fast without touching
    // the global query path.
    const columns = (db.prepare(`PRAGMA table_info(receipts)`).all() as Array<{ name?: unknown }>).map((c) => String(c.name));
    if (!columns.includes("sessionKey")) db.exec(`ALTER TABLE receipts ADD COLUMN sessionKey TEXT`);
    // Chain columns. Rows written BEFORE this migration keep NULL here forever — a chain cannot be
    // retro-fitted onto receipts nobody committed to at the time, and pretending otherwise would be the
    // exact lie this feature exists to remove. They are counted as `unchained` below and the verifier
    // refuses to certify a store that contains any.
    for (const [col, type] of [
      ["seq", "INTEGER"],
      ["leafHash", "TEXT"],
      ["prevHash", "TEXT"],
      ["entryHash", "TEXT"],
    ] as const) {
      if (!columns.includes(col)) db.exec(`ALTER TABLE receipts ADD COLUMN ${col} ${type}`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_receipts_session ON receipts (sessionKey, createdAt DESC) WHERE sessionKey IS NOT NULL`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_receipts_seq ON receipts (seq) WHERE seq IS NOT NULL`);
    // The per-scope commitment: "" is the whole store, any other scope is one session's ledger.
    db.exec(
      `CREATE TABLE IF NOT EXISTS chain_state (scope TEXT PRIMARY KEY, head TEXT NOT NULL, count INTEGER NOT NULL,
       root TEXT NOT NULL, rootCount INTEGER NOT NULL, prunedSeq INTEGER NOT NULL DEFAULT 0,
       prunedHash TEXT NOT NULL DEFAULT '', unchained INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`,
    );
    if (!db.prepare(`SELECT scope FROM chain_state WHERE scope = ?`).get(WHOLE_STORE)) {
      const unchained = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE leafHash IS NULL`).get() as { n: number }).n,
      );
      db.prepare(
        `INSERT INTO chain_state (scope, head, count, root, rootCount, prunedSeq, prunedHash, unchained, updatedAt)
         VALUES (?,?,0,?,0,0,'',?,?)`,
      ).run(WHOLE_STORE, GENESIS, await scopeRoot([]), unchained, Date.now());
    }

    type ChainRow = { head: string; count: number; root: string; rootCount: number; prunedHash: string };
    const readScope = (scope: string): ChainRow | null =>
      (db.prepare(`SELECT head, count, root, rootCount, prunedHash FROM chain_state WHERE scope = ?`).get(scope) as
        | ChainRow
        | undefined) ?? null;
    const leavesOf = (scope: string): string[] =>
      (
        db
          .prepare(
            scope === WHOLE_STORE
              ? `SELECT leafHash FROM receipts WHERE leafHash IS NOT NULL ORDER BY seq ASC`
              : `SELECT leafHash FROM receipts WHERE leafHash IS NOT NULL AND sessionKey = ? ORDER BY seq ASC`,
          )
          .all(...(scope === WHOLE_STORE ? [] : [scope])) as Array<{ leafHash: string }>
      ).map((r) => String(r.leafHash));
    const writeScope = (scope: string, s: ChainRow & { prunedSeq?: number }): void => {
      db.prepare(
        `INSERT INTO chain_state (scope, head, count, root, rootCount, prunedSeq, prunedHash, unchained, updatedAt)
         VALUES (?,?,?,?,?,?,?,COALESCE((SELECT unchained FROM chain_state WHERE scope = ?),0),?)
         ON CONFLICT(scope) DO UPDATE SET head=excluded.head, count=excluded.count, root=excluded.root,
           rootCount=excluded.rootCount, prunedSeq=excluded.prunedSeq, prunedHash=excluded.prunedHash,
           updatedAt=excluded.updatedAt`,
      ).run(scope, s.head, s.count, s.root, s.rootCount, s.prunedSeq ?? 0, s.prunedHash, scope, Date.now());
    };

    /** Bounded retention. A chain cannot silently lose rows, so a prune is RECORDED: the whole-store
     *  scope keeps the last pruned entry as its anchor, and every scope that lost rows re-seals its
     *  root over what survives. Victims are chosen by `seq` (insertion order), which guarantees the
     *  pruned set is a prefix of every scope's chain — a caller-supplied `createdAt` must not get to
     *  decide which link in the chain disappears. */
    const pruneIfNeeded = async (): Promise<void> => {
      const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM receipts`).get() as { n: number }).n);
      if (total < cap) return;
      const victims = db
        .prepare(
          `SELECT seq, entryHash, sessionKey, leafHash FROM receipts ORDER BY (seq IS NULL) DESC, seq ASC LIMIT ?`,
        )
        .all(total - cap + 1) as Array<{ seq: number | null; entryHash: string | null; sessionKey: string | null; leafHash: string | null }>;
      if (victims.length === 0) return;
      const touched = new Set<string>([WHOLE_STORE]);
      let anchorSeq = 0;
      let anchorHash = "";
      let unchainedPruned = 0;
      for (const v of victims) {
        if (v.leafHash === null) unchainedPruned++;
        else {
          anchorSeq = Number(v.seq);
          anchorHash = String(v.entryHash);
        }
        if (v.sessionKey) touched.add(String(v.sessionKey));
      }
      db.prepare(
        `DELETE FROM receipts WHERE rowid IN (
           SELECT rowid FROM receipts ORDER BY (seq IS NULL) DESC, seq ASC LIMIT ?)`,
      ).run(victims.length);
      if (unchainedPruned > 0) {
        db.prepare(`UPDATE chain_state SET unchained = MAX(0, unchained - ?) WHERE scope = ?`).run(unchainedPruned, WHOLE_STORE);
      }
      for (const scope of touched) {
        const prior = readScope(scope);
        if (!prior) continue;
        const leaves = leavesOf(scope);
        if (scope !== WHOLE_STORE && leaves.length === 0) {
          db.prepare(`DELETE FROM chain_state WHERE scope = ?`).run(scope); // the session's ledger is gone entirely
          continue;
        }
        const last = db
          .prepare(
            scope === WHOLE_STORE
              ? `SELECT entryHash FROM receipts WHERE leafHash IS NOT NULL ORDER BY seq DESC LIMIT 1`
              : `SELECT entryHash FROM receipts WHERE leafHash IS NOT NULL AND sessionKey = ? ORDER BY seq DESC LIMIT 1`,
          )
          .get(...(scope === WHOLE_STORE ? [] : [scope])) as { entryHash?: unknown } | undefined;
        writeScope(scope, {
          head: last?.entryHash ? String(last.entryHash) : anchorHash || GENESIS,
          count: leaves.length,
          root: await scopeRoot(leaves),
          rootCount: leaves.length,
          prunedSeq: scope === WHOLE_STORE ? anchorSeq : 0,
          prunedHash: scope === WHOLE_STORE ? anchorHash : "",
        });
      }
    };

    const appendReceipt = async (r: StoredReceipt): Promise<void> => {
      // Replay of the same content-addressed receipt: an EVENT, not a new link. seenCount is mutable
      // by design and is therefore deliberately outside what the leaf commits to (see ledger-chain.ts).
      const seen = db.prepare(`SELECT receiptId FROM receipts WHERE receiptId = ?`).get(r.receiptId);
      if (seen) {
        db.prepare(`UPDATE receipts SET seenCount = seenCount + 1 WHERE receiptId = ?`).run(r.receiptId);
        return;
      }
      await pruneIfNeeded();

      const whole = readScope(WHOLE_STORE)!;
      const scope = r.sessionKey;
      const session = scope ? readScope(scope) : null;
      const leaf = await leafHash(r);
      const entry = await entryHashFor(whole.head, leaf);
      const seq = Number((db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM receipts`).get() as { m: number }).m) + 1;

      // Roots are re-sealed only when the scope has drifted far enough (see shouldReseal): the chain
      // covers every row on every write; the Merkle root is the inclusion-proof commitment.
      const wholeCount = whole.count + 1;
      const wholeReseal = shouldReseal(wholeCount, whole.rootCount);
      const wholeRoot = wholeReseal ? await scopeRoot([...leavesOf(WHOLE_STORE), leaf]) : whole.root;
      const sessCount = (session?.count ?? 0) + 1;
      const sessReseal = scope ? shouldReseal(sessCount, session?.rootCount ?? 0) : false;
      const sessRoot = scope && sessReseal ? await scopeRoot([...leavesOf(scope), leaf]) : session?.root;

      db.prepare(
        `INSERT INTO receipts (receiptId, receiptHash, balanced, findingTypes, agent, merchant, deltaUsd, createdAt,
           seenCount, sessionKey, seq, leafHash, prevHash, entryHash)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      ).run(
        r.receiptId,
        r.receiptHash,
        r.balanced ? 1 : 0,
        r.findingTypes.join(","),
        r.agent,
        r.merchant,
        r.deltaUsd,
        r.createdAt,
        r.sessionKey ?? null,
        seq,
        leaf,
        whole.head,
        entry,
      );
      writeScope(WHOLE_STORE, {
        head: entry,
        count: wholeCount,
        root: wholeRoot,
        rootCount: wholeReseal ? wholeCount : whole.rootCount,
        prunedSeq: Number((db.prepare(`SELECT prunedSeq AS s FROM chain_state WHERE scope = ?`).get(WHOLE_STORE) as { s: number }).s),
        prunedHash: whole.prunedHash,
      });
      if (scope) {
        writeScope(scope, {
          head: entry,
          count: sessCount,
          root: sessRoot ?? (await scopeRoot([])),
          rootCount: sessReseal ? sessCount : (session?.rootCount ?? 0),
          prunedHash: "",
        });
      }
    };

    // A chain is a strictly ordered structure: two concurrent saves that both read the same head would
    // fork it. Node is single-threaded but `await` yields, so appends are serialized through a promise
    // queue — the store is a single-process durable log, and this is what makes that claim true.
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = queue.then(fn, fn);
      queue = next.catch(() => undefined);
      return next;
    };

    return {
      backend: "sqlite",
      // Content-addressed append: a replay of the same receipt bumps seenCount (the event counter)
      // and keeps the FIRST createdAt — an audit log records when something was first seen. A genuinely
      // new receipt extends the hash chain and re-commits its scopes.
      save: (r) => serialize(() => appendReceipt(r)),
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
      listBySession: (sessionKey, limit = 100) =>
        (
          db
            .prepare(`SELECT * FROM receipts WHERE sessionKey = ? ORDER BY createdAt DESC LIMIT ?`)
            .all(sessionKey, limit) as Record<string, unknown>[]
        ).map(toRow),
      statsBySession: (sessionKey) => {
        // Same narrow projection as stats(), filtered to one session key (parameter-bound, never interpolated).
        const rows = db
          .prepare(`SELECT balanced, findingTypes, seenCount FROM receipts WHERE sessionKey = ?`)
          .all(sessionKey) as Record<string, unknown>[];
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
