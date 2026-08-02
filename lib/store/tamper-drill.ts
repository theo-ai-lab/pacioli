/**
 * Pacioli — the ledger TAMPER DRILL: a scripted adversary with write access to the sqlite file.
 *
 * The chain and the verifier make "tamper-evident" checkable. This makes it *drilled*: a registry of
 * tamper CLASSES, each applied to a fresh COPY of a real ledger with seeded random targets, and one
 * invariant over the whole space —
 *
 *     for any tamper drawn from the in-model space, verifyLedger() must FAIL
 *
 * plus a negative control (an untampered ledger must PASS) without which the invariant is worthless.
 *
 * ADVERSARY MODEL. In model: any mutation of `receipts`, and any PARTIAL mutation of `chain_state`
 * (rewriting a commitment without re-deriving every other commitment from the rows). Out of model,
 * and therefore PINNED as boundaries the drill expects to pass: `seenCount`, which the leaf
 * deliberately does not cover, and a FULL RE-SEAL, where the adversary recomputes every leaf, link
 * and scope commitment so the file becomes a self-consistent ledger of a different history. The
 * second is undetectable from the file alone by construction — catching it needs an off-box anchor,
 * not a better walk — and saying so out loud is the point of pinning it.
 *
 * Never mutates the ledger it is pointed at: every case runs against a copy.
 * Zero new dependencies — node:sqlite, the engine's hash primitives, a seeded PRNG.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GENESIS, WHOLE_STORE, leafHash, entryHashFor, scopeRoot, type LedgerFacts } from "./ledger-chain";
import { verifyLedger } from "./verify-ledger";

/** Whether a class is one the verifier must catch, or a documented limit the drill pins. */
export type AdversaryModel = "in-model" | "boundary";

export interface TamperClass {
  /** Stable id — it is the coverage unit, and it appears in the committed report. */
  readonly id: string;
  readonly model: AdversaryModel;
  /** One line: what an operator would have to believe for this tamper to work. */
  readonly what: string;
  /**
   * Mutate the OPEN, WRITABLE copy in place. Return a located description of what was done, or null
   * when the class cannot apply to this ledger (recorded as SKIPPED — never counted as caught).
   */
  apply(db: DrillDb, ctx: LedgerSnapshot, rng: () => number): Promise<string | null>;
}

export interface DrillOptions {
  /** The ledger to attack. Copied per case; never written to. */
  ledger: string;
  /** Scratch directory for the copies (created, and cleaned up on the way out). */
  workdir: string;
  /** Seeds to draw targets from. Same seeds ⇒ same report. */
  seeds?: number[];
  /** Override the registry (the drill is the registry; tests may narrow it). */
  classes?: readonly TamperClass[];
}

export interface ClassResult {
  id: string;
  model: AdversaryModel;
  what: string;
  attempted: number;
  skipped: number;
  /** Caught, for an in-model class; still verifying, for a pinned boundary. */
  asExpected: number;
  /** Every distinct fault kind this class provoked, sorted — the report's evidence column. */
  faultKinds: string[];
}

export interface DrillOutcome {
  classId: string;
  seed: number;
  what: string;
}

export interface DrillReport {
  seeds: number[];
  /** THE NEGATIVE CONTROL. An untampered copy must verify, or nothing below means anything. */
  control: { ok: boolean; receipts: number; faults: string[] };
  classes: ClassResult[];
  attempted: number;
  skipped: number;
  /** In-model tampers the verifier PASSED. Any entry here is a real defect. */
  escapes: DrillOutcome[];
  /** Documented boundaries that started failing — the claim moved and must be re-stated. */
  pinBreaks: Array<DrillOutcome & { faultKinds: string[] }>;
  /** Caught cases whose report named no located fault (a bare failure is not evidence). */
  unlocated: string[];
  ok: boolean;
}

interface Stmt {
  run(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  get(...a: unknown[]): unknown;
}
export interface DrillDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

export interface ChainedRow extends LedgerFacts {
  seq: number;
  leafHash: string;
  prevHash: string;
  entryHash: string;
  rawFindingTypes: string;
  rawBalanced: number;
}
export interface ScopeRow {
  scope: string;
  head: string;
  count: number;
  root: string;
  rootCount: number;
  prunedHash: string;
  unchained: number;
}
export interface LedgerSnapshot {
  rows: ChainedRow[];
  scopes: ScopeRow[];
  sessions: string[];
}

const NODE_SQLITE = "node:sqlite";

/** mulberry32 — a tiny seeded PRNG, so every case is reproducible from (seed, class). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)];
const HEX = "0123456789abcdef";
const fakeHex = (rng: () => number): string =>
  Array.from({ length: 64 }, () => HEX[Math.floor(rng() * 16)]).join("");

async function openRaw(path: string): Promise<DrillDb> {
  const { DatabaseSync } = (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => DrillDb };
  return new DatabaseSync(path);
}

function snapshot(db: DrillDb): LedgerSnapshot {
  const rows = (
    db
      .prepare(
        `SELECT receiptId, receiptHash, balanced, findingTypes, agent, merchant, deltaUsd, createdAt,
                sessionKey, seq, leafHash, prevHash, entryHash FROM receipts
         WHERE leafHash IS NOT NULL ORDER BY seq ASC`,
      )
      .all() as Record<string, unknown>[]
  ).map(
    (o): ChainedRow => ({
      receiptId: String(o.receiptId),
      receiptHash: String(o.receiptHash),
      balanced: o.balanced === 1,
      rawBalanced: Number(o.balanced),
      findingTypes: o.findingTypes ? String(o.findingTypes).split(",").filter(Boolean) : [],
      rawFindingTypes: o.findingTypes === null || o.findingTypes === undefined ? "" : String(o.findingTypes),
      agent: String(o.agent),
      merchant: String(o.merchant),
      deltaUsd: o.deltaUsd === null || o.deltaUsd === undefined ? null : Number(o.deltaUsd),
      createdAt: Number(o.createdAt),
      sessionKey: o.sessionKey === null || o.sessionKey === undefined ? undefined : String(o.sessionKey),
      seq: Number(o.seq),
      leafHash: String(o.leafHash),
      prevHash: String(o.prevHash),
      entryHash: String(o.entryHash),
    }),
  );
  const scopes = (
    db.prepare(`SELECT scope, head, count, root, rootCount, prunedHash, unchained FROM chain_state`).all() as Record<
      string,
      unknown
    >[]
  ).map(
    (o): ScopeRow => ({
      scope: String(o.scope),
      head: String(o.head),
      count: Number(o.count),
      root: String(o.root),
      rootCount: Number(o.rootCount),
      prunedHash: String(o.prunedHash ?? ""),
      unchained: Number(o.unchained ?? 0),
    }),
  );
  return { rows, scopes, sessions: [...new Set(rows.map((r) => r.sessionKey).filter((s): s is string => !!s))].sort() };
}

const setRow = (db: DrillDb, receiptId: string, column: string, value: unknown): void => {
  // `column` is never caller-supplied — it comes from the literals in this file's own class registry.
  db.prepare(`UPDATE receipts SET ${column} = ? WHERE receiptId = ?`).run(value, receiptId);
};
const maxSeq = (db: DrillDb): number =>
  Number((db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM receipts`).get() as { m: number }).m);

/**
 * THE REGISTRY. Each entry is one way to lie about the past. Adding a class here extends the
 * invariant automatically — that is the whole reason the drill is a registry and not a test list.
 */
export const TAMPER_CLASSES: readonly TamperClass[] = [
  // ── EDIT A ROW IN PLACE ─────────────────────────────────────────────────────────────────────
  {
    id: "edit-clear-a-finding",
    model: "in-model",
    what: "flip a flagged receipt to balanced and erase its finding — the forgery the product exists to stop",
    async apply(db, ctx, rng) {
      const flagged = ctx.rows.filter((r) => !r.balanced);
      if (flagged.length === 0) return null;
      const r = pick(flagged, rng);
      db.prepare(`UPDATE receipts SET balanced = 1, findingTypes = '', deltaUsd = NULL WHERE receiptId = ?`).run(r.receiptId);
      return `cleared the finding on ${r.receiptId} (seq ${r.seq})`;
    },
  },
  {
    id: "edit-merchant",
    model: "in-model",
    what: "rewrite who the money went to",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "merchant", `${r.merchant}-forged`);
      return `merchant of ${r.receiptId} → ${r.merchant}-forged`;
    },
  },
  {
    id: "edit-agent",
    model: "in-model",
    what: "reassign the blame to a different agent",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "agent", "someone-else");
      return `agent of ${r.receiptId} → someone-else`;
    },
  },
  {
    id: "edit-delta",
    model: "in-model",
    what: "shrink the discrepancy without clearing it",
    async apply(db, ctx, rng) {
      const withDelta = ctx.rows.filter((r) => r.deltaUsd !== null);
      if (withDelta.length === 0) return null;
      const r = pick(withDelta, rng);
      setRow(db, r.receiptId, "deltaUsd", (r.deltaUsd as number) / 10);
      return `deltaUsd of ${r.receiptId} ${r.deltaUsd} → ${(r.deltaUsd as number) / 10}`;
    },
  },
  {
    id: "edit-timestamp",
    model: "in-model",
    what: "move a receipt into a different reporting period",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "createdAt", r.createdAt - 86_400_000);
      return `createdAt of ${r.receiptId} back-dated one day`;
    },
  },
  {
    id: "edit-content-address",
    model: "in-model",
    what: "repoint a row at a different receipt body",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "receiptHash", `h-forged-${r.seq}`);
      return `receiptHash of ${r.receiptId} → h-forged-${r.seq}`;
    },
  },
  {
    id: "edit-receipt-id",
    model: "in-model",
    what: "rename a receipt so a citation of it dangles",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "receiptId", `${r.receiptId}x`);
      return `receiptId ${r.receiptId} → ${r.receiptId}x`;
    },
  },
  {
    id: "edit-add-a-finding",
    model: "in-model",
    what: "frame a clean receipt by adding a finding to it",
    async apply(db, ctx, rng) {
      const clean = ctx.rows.filter((r) => r.balanced);
      if (clean.length === 0) return null;
      const r = pick(clean, rng);
      db.prepare(`UPDATE receipts SET balanced = 0, findingTypes = 'OVERSPEND', deltaUsd = 999 WHERE receiptId = ?`).run(
        r.receiptId,
      );
      return `framed ${r.receiptId} with a fabricated OVERSPEND`;
    },
  },
  // ── REMOVE, REORDER, RE-INSERT ──────────────────────────────────────────────────────────────
  {
    id: "delete-interior-row",
    model: "in-model",
    what: "make one inconvenient receipt disappear from the middle of the history",
    async apply(db, ctx, rng) {
      if (ctx.rows.length < 3) return null;
      const r = pick(ctx.rows.slice(0, -1), rng);
      db.prepare(`DELETE FROM receipts WHERE receiptId = ?`).run(r.receiptId);
      return `deleted interior row ${r.receiptId} (seq ${r.seq})`;
    },
  },
  {
    id: "truncate-tail",
    model: "in-model",
    what: "lop the newest receipts off the end — a valid chain, just a shorter one",
    async apply(db, ctx, rng) {
      if (ctx.rows.length < 3) return null;
      const k = 1 + Math.floor(rng() * Math.min(3, ctx.rows.length - 1));
      const victims = ctx.rows.slice(-k);
      for (const v of victims) db.prepare(`DELETE FROM receipts WHERE receiptId = ?`).run(v.receiptId);
      return `truncated the newest ${k} row(s): ${victims.map((v) => v.receiptId).join(", ")}`;
    },
  },
  {
    id: "reorder-rows",
    model: "in-model",
    what: "swap two receipts' positions so the story reads differently",
    async apply(db, ctx, rng) {
      if (ctx.rows.length < 2) return null;
      const i = Math.floor(rng() * ctx.rows.length);
      let j = Math.floor(rng() * ctx.rows.length);
      if (j === i) j = (i + 1) % ctx.rows.length;
      const [a, b] = [ctx.rows[i], ctx.rows[j]];
      setRow(db, a.receiptId, "seq", -1);
      setRow(db, b.receiptId, "seq", a.seq);
      setRow(db, a.receiptId, "seq", b.seq);
      return `swapped seq ${a.seq} (${a.receiptId}) with seq ${b.seq} (${b.receiptId})`;
    },
  },
  {
    id: "reinsert-deleted-row",
    model: "in-model",
    what: "delete a receipt and paste it back at the end, chain columns and all",
    async apply(db, ctx, rng) {
      if (ctx.rows.length < 3) return null;
      const r = pick(ctx.rows.slice(0, -1), rng);
      db.prepare(`DELETE FROM receipts WHERE receiptId = ?`).run(r.receiptId);
      db.prepare(
        `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,
           seenCount,sessionKey,seq,leafHash,prevHash,entryHash) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      ).run(
        r.receiptId,
        r.receiptHash,
        r.balanced ? 1 : 0,
        r.rawFindingTypes,
        r.agent,
        r.merchant,
        r.deltaUsd,
        r.createdAt,
        r.sessionKey ?? null,
        maxSeq(db) + 1,
        r.leafHash,
        r.prevHash,
        r.entryHash,
      );
      return `re-inserted ${r.receiptId} at the tail with its original chain columns`;
    },
  },
  {
    id: "duplicate-sequence-number",
    model: "in-model",
    what: "collide two receipts on one sequence number so the order is ambiguous",
    async apply(db, ctx, rng) {
      if (ctx.rows.length < 2) return null;
      const i = Math.floor(rng() * (ctx.rows.length - 1));
      const [a, b] = [ctx.rows[i], ctx.rows[i + 1]];
      setRow(db, b.receiptId, "seq", a.seq);
      return `${b.receiptId} now shares seq ${a.seq} with ${a.receiptId}`;
    },
  },
  // ── FORGE ROWS IN ───────────────────────────────────────────────────────────────────────────
  {
    id: "append-forged-chain",
    model: "in-model",
    what: "append a receipt that never happened, with plausible-looking chain columns",
    async apply(db, ctx, rng) {
      const id = `sha256:forged${Math.floor(rng() * 1e9)}`;
      db.prepare(
        `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,
           seenCount,sessionKey,seq,leafHash,prevHash,entryHash) VALUES (?,?,1,'','booker','United',NULL,?,1,?,?,?,?,?)`,
      ).run(id, `h${id}`, 1_900_000_000_000, ctx.sessions[0] ?? null, maxSeq(db) + 1, fakeHex(rng), fakeHex(rng), fakeHex(rng));
      return `appended forged receipt ${id} with invented chain columns`;
    },
  },
  {
    id: "append-null-chain",
    model: "in-model",
    what: "one plain INSERT with the chain columns left empty — the CHEAPEST forgery, and it never touches chain_state",
    async apply(db, ctx, rng) {
      const id = `sha256:unchained${Math.floor(rng() * 1e9)}`;
      db.prepare(
        `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,
           seenCount,sessionKey) VALUES (?,?,1,'','attacker','Acme',NULL,?,1,?)`,
      ).run(id, `h${id}`, 1_900_000_000_000, ctx.sessions[0] ?? null);
      return `inserted ${id} carrying no chain commitment at all`;
    },
  },
  {
    id: "splice-row-into-another-scope",
    model: "in-model",
    what: "move a receipt into someone else's session ledger",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      const target = ctx.sessions.find((s) => s !== r.sessionKey) ?? "user-mallory";
      setRow(db, r.receiptId, "sessionKey", target);
      return `spliced ${r.receiptId} from ${r.sessionKey ?? "(no session)"} into ${target}`;
    },
  },
  {
    id: "null-a-chain-column",
    model: "in-model",
    what: "blank one chain column so the row falls out of the walk",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      const col = pick(["leafHash", "prevHash", "entryHash"] as const, rng);
      setRow(db, r.receiptId, col, null);
      return `NULLed ${col} on ${r.receiptId} (seq ${r.seq})`;
    },
  },
  {
    id: "empty-a-chain-column",
    model: "in-model",
    what: "set a chain column to '' — not NULL, so it dodges an IS NULL filter",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      const col = pick(["leafHash", "prevHash", "entryHash"] as const, rng);
      setRow(db, r.receiptId, col, "");
      return `emptied ${col} on ${r.receiptId} (seq ${r.seq})`;
    },
  },
  {
    id: "wipe-every-chain-column",
    model: "in-model",
    what: "strip the whole chain and leave the receipts, so the store looks like it predates it",
    async apply(db) {
      db.exec(`UPDATE receipts SET leafHash = NULL, prevHash = NULL, entryHash = NULL`);
      return `stripped the chain columns from every row`;
    },
  },
  // ── REWRITE THE COMMITMENTS (PARTIALLY — a full re-seal is pinned as a boundary below) ───────
  {
    id: "rewrite-scope-count",
    model: "in-model",
    what: "adjust a scope's committed receipt count to cover a removal",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      const to = s.count + (rng() < 0.5 ? 1 : -1);
      db.prepare(`UPDATE chain_state SET count = ? WHERE scope = ?`).run(to, s.scope);
      return `scope ${JSON.stringify(s.scope)} count ${s.count} → ${to}`;
    },
  },
  {
    id: "rewrite-scope-head",
    model: "in-model",
    what: "point a scope's head somewhere else",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      const to = fakeHex(rng);
      db.prepare(`UPDATE chain_state SET head = ? WHERE scope = ?`).run(to, s.scope);
      return `scope ${JSON.stringify(s.scope)} head → ${to.slice(0, 16)}…`;
    },
  },
  {
    id: "rewrite-scope-root",
    model: "in-model",
    what: "swap in a Merkle root that commits to a different set",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      const to = fakeHex(rng);
      db.prepare(`UPDATE chain_state SET root = ? WHERE scope = ?`).run(to, s.scope);
      return `scope ${JSON.stringify(s.scope)} root → ${to.slice(0, 16)}…`;
    },
  },
  {
    id: "rewrite-scope-rootcount-negative",
    model: "in-model",
    what: "make the Merkle check vacuous with a NEGATIVE rootCount and the empty root",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      // The magnitude matters and must be DRAWN, not fixed: slice(0, -k) counts back from the end, so a
      // small k only trims the tail while a k past the length empties the set. A generator that only
      // ever tried -1 would have missed the second half of the space entirely.
      const to = -(1 + Math.floor(rng() * 24));
      db.prepare(`UPDATE chain_state SET rootCount = ?, root = ? WHERE scope = ?`).run(to, await scopeRoot([]), s.scope);
      return `scope ${JSON.stringify(s.scope)} rootCount → ${to} with the empty-set root`;
    },
  },
  {
    id: "rewrite-scope-rootcount-nonnumeric",
    model: "in-model",
    what: "same evasion with a NON-NUMERIC rootCount — a comparison against NaN is always false",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      db.prepare(`UPDATE chain_state SET rootCount = 'x', root = ? WHERE scope = ?`).run(await scopeRoot([]), s.scope);
      return `scope ${JSON.stringify(s.scope)} rootCount → 'x' with the empty-set root`;
    },
  },
  {
    id: "zero-out-a-scope",
    model: "in-model",
    what: "reset one scope's commitment to 'empty ledger' while its receipts are still there",
    async apply(db, ctx, rng) {
      const s = pick(ctx.scopes, rng);
      db.prepare(`UPDATE chain_state SET count = 0, head = ?, root = ?, rootCount = 0 WHERE scope = ?`).run(
        GENESIS,
        await scopeRoot([]),
        s.scope,
      );
      return `scope ${JSON.stringify(s.scope)} reset to an empty commitment with ${s.count} receipts still present`;
    },
  },
  {
    id: "drop-a-session-scope",
    model: "in-model",
    what: "delete a session's commitment so its ledger has nothing to check against",
    async apply(db, ctx, rng) {
      if (ctx.sessions.length === 0) return null;
      const s = pick(ctx.sessions, rng);
      db.prepare(`DELETE FROM chain_state WHERE scope = ?`).run(s);
      return `dropped the committed chain state for session ${JSON.stringify(s)}`;
    },
  },
  {
    id: "forge-an-empty-session-scope",
    model: "in-model",
    what: "invent a session ledger that never existed, committed to zero receipts",
    async apply(db, ctx, rng) {
      const ghost = `user-ghost-${Math.floor(rng() * 1e6)}`;
      db.prepare(
        `INSERT INTO chain_state (scope, head, count, root, rootCount, prunedSeq, prunedHash, unchained, updatedAt)
         VALUES (?,?,0,?,0,0,'',0,?)`,
      ).run(ghost, GENESIS, await scopeRoot([]), 1_900_000_000_000);
      return `forged an empty session ledger ${JSON.stringify(ghost)}`;
    },
  },
  {
    id: "forge-a-prune-anchor",
    model: "in-model",
    what: "plant a pruned-anchor hash so the chain appears to start after a prune that never happened",
    async apply(db, ctx, rng) {
      const to = fakeHex(rng);
      db.prepare(`UPDATE chain_state SET prunedHash = ? WHERE scope = ?`).run(to, WHOLE_STORE);
      return `whole-store prunedHash → ${to.slice(0, 16)}… (no rows removed)`;
    },
  },
  {
    id: "lie-about-uncommitted-rows",
    model: "in-model",
    what: "inflate the pre-chain row counter to reserve room for a forgery",
    async apply(db, ctx, rng) {
      const whole = ctx.scopes.find((s) => s.scope === WHOLE_STORE)!;
      const to = whole.unchained + 1 + Math.floor(rng() * 3);
      db.prepare(`UPDATE chain_state SET unchained = ? WHERE scope = ?`).run(to, WHOLE_STORE);
      return `whole-store unchained counter ${whole.unchained} → ${to}`;
    },
  },
  // ── MALFORMED ENCODINGS (the misuse-resistance probe: a check SKIPPED is worse than a check FAILED) ─
  {
    id: "malformed-delta-nonnumeric",
    model: "in-model",
    what: "put text in the money column: a coerced NaN must not read as the committed null",
    async apply(db, ctx, rng) {
      const nulls = ctx.rows.filter((r) => r.deltaUsd === null);
      if (nulls.length === 0) return null;
      const r = pick(nulls, rng);
      setRow(db, r.receiptId, "deltaUsd", "n/a");
      return `deltaUsd of ${r.receiptId} null → the text 'n/a'`;
    },
  },
  {
    id: "malformed-findingtypes-padding",
    model: "in-model",
    what: "pad the finding list with empty members — a different stored row that decodes the same",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      const padded = `,${r.rawFindingTypes},`;
      setRow(db, r.receiptId, "findingTypes", padded);
      return `findingTypes of ${r.receiptId} ${JSON.stringify(r.rawFindingTypes)} → ${JSON.stringify(padded)}`;
    },
  },
  {
    id: "malformed-balanced-out-of-range",
    model: "in-model",
    what: "store a verdict that is neither 0 nor 1 and let every reader coerce it its own way",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      setRow(db, r.receiptId, "balanced", r.rawBalanced === 1 ? 2 : -1);
      return `balanced of ${r.receiptId} ${r.rawBalanced} → ${r.rawBalanced === 1 ? 2 : -1}`;
    },
  },
  {
    id: "malformed-seq-null",
    model: "in-model",
    what: "drop a chained row's position so it sorts wherever the engine feels like",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows.slice(1), rng);
      setRow(db, r.receiptId, "seq", null);
      return `seq of ${r.receiptId} → NULL`;
    },
  },
  // ── PINNED BOUNDARIES — these must still VERIFY, and the docs must keep saying why ───────────
  {
    id: "boundary-seen-count",
    model: "boundary",
    what: "bump the replay counter: seenCount is mutable by design and deliberately outside the leaf",
    async apply(db, ctx, rng) {
      const r = pick(ctx.rows, rng);
      db.prepare(`UPDATE receipts SET seenCount = seenCount + 7 WHERE receiptId = ?`).run(r.receiptId);
      return `seenCount of ${r.receiptId} += 7`;
    },
  },
  {
    id: "boundary-seq-renumber",
    model: "boundary",
    what: "renumber every position while KEEPING their order: seq is read as an order and is not among the facts a leaf commits to",
    async apply(db, ctx, rng) {
      // The exposure this pins is real but INERT. `seq` orders the walk, orders a scope's leaves and
      // chooses a prune's victims — but every one of those uses is RELATIVE, and an order-preserving
      // renumbering leaves each of them deciding exactly what it decided before. What is NOT
      // order-preserving is already in model above (`reorder-rows`, `duplicate-sequence-number`,
      // `malformed-seq-null`), so this is precisely the residue: undetectable, and inert.
      if (ctx.rows.length === 0) return null;
      const scale = 2 + Math.floor(rng() * 8);
      const offset = 1 + Math.floor(rng() * 1000);
      db.prepare(`UPDATE receipts SET seq = seq * ? + ? WHERE leafHash IS NOT NULL`).run(scale, offset);
      return `renumbered every position seq → seq*${scale}+${offset} (order preserved)`;
    },
  },
  {
    id: "boundary-prefix-prune",
    model: "boundary",
    what: "delete the OLDEST receipts and record it as a prune — indistinguishable from bounded retention, which is the point of retention",
    async apply(db, ctx, rng) {
      // The cheapest realistic version of a re-seal: the adversary never touches a surviving row, only
      // the prefix and the commitments. It is exactly the shape `pruneIfNeeded()` produces, so no
      // walk over this file can separate the two — retention is a legitimate reason for old rows to
      // be gone. What bounds it is that the pruned range is a PREFIX (a prune cannot reach into the
      // middle of the chain) and that an off-box anchor of an older root would still contradict it.
      if (ctx.rows.length < 2) return null;
      const k = 1 + Math.floor(rng() * (ctx.rows.length - 1));
      const [victims, survivors] = [ctx.rows.slice(0, k), ctx.rows.slice(k)];
      for (const v of victims) db.prepare(`DELETE FROM receipts WHERE receiptId = ?`).run(v.receiptId);
      const anchor = victims.at(-1)!;
      for (const s of ctx.scopes) {
        const inScope = s.scope === WHOLE_STORE ? survivors : survivors.filter((r) => r.sessionKey === s.scope);
        if (s.scope !== WHOLE_STORE && inScope.length === 0) {
          db.prepare(`DELETE FROM chain_state WHERE scope = ?`).run(s.scope);
          continue;
        }
        db.prepare(
          `UPDATE chain_state SET count = ?, head = ?, root = ?, rootCount = ?, prunedSeq = ?, prunedHash = ? WHERE scope = ?`,
        ).run(
          inScope.length,
          inScope.at(-1)!.entryHash,
          await scopeRoot(inScope.map((r) => r.leafHash)),
          inScope.length,
          s.scope === WHOLE_STORE ? anchor.seq : 0,
          s.scope === WHOLE_STORE ? anchor.entryHash : "",
          s.scope,
        );
      }
      return `deleted the oldest ${k} receipt(s) and re-anchored the chain at seq ${anchor.seq}`;
    },
  },
  {
    id: "boundary-full-reseal-wipe",
    model: "boundary",
    what: "delete every receipt AND reset every commitment: an empty ledger is a valid ledger",
    async apply(db) {
      db.exec(`DELETE FROM receipts`);
      db.prepare(`DELETE FROM chain_state WHERE scope <> ?`).run(WHOLE_STORE);
      db.prepare(
        `UPDATE chain_state SET count = 0, head = ?, root = ?, rootCount = 0, prunedSeq = 0, prunedHash = '', unchained = 0
         WHERE scope = ?`,
      ).run(GENESIS, await scopeRoot([]), WHOLE_STORE);
      return `wiped the ledger and re-sealed it as empty`;
    },
  },
  {
    id: "boundary-full-reseal-rewrite",
    model: "boundary",
    what: "edit a receipt and RE-DERIVE every leaf, link and commitment — self-consistent, and only an off-box anchor can tell",
    async apply(db, ctx, rng) {
      if (ctx.rows.length === 0) return null;
      const target = pick(ctx.rows, rng);
      db.prepare(`UPDATE receipts SET balanced = 1, findingTypes = '', deltaUsd = NULL WHERE receiptId = ?`).run(
        target.receiptId,
      );
      const rewritten = ctx.rows.map((r) =>
        r.receiptId === target.receiptId ? { ...r, balanced: true, findingTypes: [], deltaUsd: null } : r,
      );
      const whole = ctx.scopes.find((s) => s.scope === WHOLE_STORE)!;
      let prev = whole.prunedHash || GENESIS;
      const entries = new Map<string, { leaf: string; entry: string }>();
      for (const r of rewritten) {
        const leaf = await leafHash(r);
        const entry = await entryHashFor(prev, leaf);
        db.prepare(`UPDATE receipts SET leafHash = ?, prevHash = ?, entryHash = ? WHERE receiptId = ?`).run(
          leaf,
          prev,
          entry,
          r.receiptId,
        );
        entries.set(r.receiptId, { leaf, entry });
        prev = entry;
      }
      for (const s of ctx.scopes) {
        const inScope = s.scope === WHOLE_STORE ? rewritten : rewritten.filter((r) => r.sessionKey === s.scope);
        const leaves = inScope.map((r) => entries.get(r.receiptId)!.leaf);
        db.prepare(`UPDATE chain_state SET count = ?, head = ?, root = ?, rootCount = ? WHERE scope = ?`).run(
          leaves.length,
          inScope.length === 0 ? s.prunedHash || GENESIS : entries.get(inScope.at(-1)!.receiptId)!.entry,
          await scopeRoot(leaves),
          leaves.length,
          s.scope,
        );
      }
      return `re-sealed the entire file around a cleared finding on ${target.receiptId}`;
    },
  },
];

/** Run the drill. The ledger is never written to — every case runs against a copy. */
export async function runTamperDrill(opts: DrillOptions): Promise<DrillReport> {
  const seeds = opts.seeds ?? [1, 2, 3, 4];
  const classes = opts.classes ?? TAMPER_CLASSES;
  mkdirSync(opts.workdir, { recursive: true });

  try {
    // THE NEGATIVE CONTROL, first: if an untampered copy does not verify, nothing below is evidence.
    const controlPath = join(opts.workdir, "control.db");
    copyFileSync(opts.ledger, controlPath);
    const control = await verifyLedger(controlPath);

    const results = new Map<string, ClassResult>();
    const escapes: DrillOutcome[] = [];
    const pinBreaks: Array<DrillOutcome & { faultKinds: string[] }> = [];
    const unlocated: string[] = [];
    let caseNo = 0;

    for (const seed of seeds) {
      for (const klass of classes) {
        const r =
          results.get(klass.id) ??
          ({ id: klass.id, model: klass.model, what: klass.what, attempted: 0, skipped: 0, asExpected: 0, faultKinds: [] } as ClassResult);
        results.set(klass.id, r);

        const path = join(opts.workdir, `case-${caseNo++}.db`);
        copyFileSync(opts.ledger, path);
        const db = await openRaw(path);
        let what: string | null;
        try {
          what = await klass.apply(db, snapshot(db), mulberry32(seed * 7919 + hash(klass.id)));
        } finally {
          db.close();
        }
        if (what === null) {
          r.skipped++;
          rmSync(path, { force: true });
          continue;
        }
        r.attempted++;

        const report = await verifyLedger(path);
        rmSync(path, { force: true });
        const kinds = report.faults.map((f) => f.kind);
        for (const k of kinds) if (!r.faultKinds.includes(k)) r.faultKinds.push(k);

        const expectedToFail = klass.model === "in-model";
        if (report.ok === !expectedToFail) {
          r.asExpected++;
        } else if (expectedToFail) {
          escapes.push({ classId: klass.id, seed, what });
        } else {
          pinBreaks.push({ classId: klass.id, seed, what, faultKinds: [...new Set(kinds)].sort() });
        }
        if (!report.ok && (report.faults.length === 0 || report.faults.some((f) => !f.detail?.trim()))) {
          unlocated.push(`${klass.id} (seed ${seed})`);
        }
      }
    }

    const classResults = [...results.values()].map((c) => ({ ...c, faultKinds: [...c.faultKinds].sort() }));
    classResults.sort((a, b) => a.id.localeCompare(b.id));
    return {
      seeds: [...seeds],
      control: { ok: control.ok, receipts: control.receipts, faults: control.faults.map((f) => f.kind) },
      classes: classResults,
      attempted: classResults.reduce((n, c) => n + c.attempted, 0),
      skipped: classResults.reduce((n, c) => n + c.skipped, 0),
      escapes,
      pinBreaks,
      unlocated,
      ok: control.ok && escapes.length === 0 && pinBreaks.length === 0 && unlocated.length === 0,
    };
  } finally {
    rmSync(opts.workdir, { recursive: true, force: true });
  }
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

/**
 * The published report. Deterministic by construction — no timestamps, no durations, no absolute
 * paths — so CI can regenerate it and hold it to a byte-for-byte diff, the same way the eval snapshot
 * is held. A drill nobody can re-run is an anecdote.
 */
export function renderDrillReport(r: DrillReport, target: string): string {
  const inModel = r.classes.filter((c) => c.model === "in-model");
  const boundaries = r.classes.filter((c) => c.model === "boundary");
  const caught = inModel.reduce((n, c) => n + c.asExpected, 0);
  const attempted = inModel.reduce((n, c) => n + c.attempted, 0);
  const L: string[] = [];

  L.push(`# Ledger tamper drill — results`);
  L.push(``);
  L.push(`<!-- GENERATED by \`npm run drill:tamper -- --report docs/TAMPER-DRILL.md\`. Do not edit by hand. -->`);
  L.push(``);
  L.push(
    `A scripted adversary with write access to the sqlite file mutates a **copy** of \`${target}\` one class ` +
      `at a time, with targets drawn from a seeded generator, and the verifier must catch every one. Seeds ` +
      `\`${r.seeds.join(", ")}\` · ${inModel.length} in-model classes · ${attempted} cases.`,
  );
  L.push(``);
  L.push(`**Negative control** — an untampered copy of the same ledger: ${r.control.ok ? "**VERIFIES**" : "**FAILED**"} ` +
    `(${r.control.receipts} receipts${r.control.faults.length ? `, faults: ${r.control.faults.join(", ")}` : ""}). ` +
    `A drill whose verifier rejects everything proves nothing, so this line comes first.`);
  L.push(``);
  L.push(`**Result: ${caught}/${attempted} in-model tampers caught (${pct(caught, attempted)}) · ${r.escapes.length} escaped.**`);
  L.push(``);
  L.push(`## In-model — every one of these must FAIL verification`);
  L.push(``);
  L.push(`| class | the lie it tells | cases | caught | located by |`);
  L.push(`|---|---|---:|---:|---|`);
  for (const c of inModel) {
    const cases = c.attempted === 0 ? `0 *(n/a here)*` : String(c.attempted);
    L.push(`| \`${c.id}\` | ${c.what} | ${cases} | ${c.attempted === 0 ? "—" : `${c.asExpected}/${c.attempted}`} | ${c.faultKinds.map((k) => `\`${k}\``).join(", ") || "—"} |`);
  }
  L.push(``);
  L.push(`## Escapes`);
  L.push(``);
  if (r.escapes.length === 0) {
    L.push(`None. Every generated tamper in the in-model space was caught and located.`);
  } else {
    L.push(`**${r.escapes.length} tamper(s) the verifier PASSED — each one is a defect, not a statistic:**`);
    L.push(``);
    for (const e of r.escapes) L.push(`- \`${e.classId}\` (seed ${e.seed}): ${e.what}`);
  }
  L.push(``);
  L.push(`## Pinned boundaries — these must still VERIFY`);
  L.push(``);
  L.push(`The chain proves internal consistency, not authorship. These are the limits stated in`);
  L.push(`[docs/VERIFICATION.md](VERIFICATION.md); the drill pins them so that if one ever moves, it moves`);
  L.push(`deliberately and the claim gets re-stated with it.`);
  L.push(``);
  L.push(`| class | why it is out of the model | cases | still verifies |`);
  L.push(`|---|---|---:|---:|`);
  for (const c of boundaries) {
    L.push(`| \`${c.id}\` | ${c.what} | ${c.attempted} | ${c.asExpected}/${c.attempted} |`);
  }
  L.push(``);
  L.push(
    `Catching a full re-seal from the file alone is impossible by construction — the adversary rewrites the ` +
      `evidence and the record of the evidence in one pass. It needs an off-box anchor (a published root, or a ` +
      `signature over it), which is why the roots are exposed rather than kept internal.`,
  );
  L.push(``);
  return L.join("\n");
}

/** Stable per-class seed offset, so two classes drawing from the same seed don't pick the same target. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 8;
}
