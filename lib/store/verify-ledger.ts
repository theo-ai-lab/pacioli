/**
 * Pacioli — the durable ledger verifier. Walks a persisted receipt store end to end and reports the
 * FIRST place the record stops being self-consistent, located by scope, sequence and receipt id.
 *
 * This is the thing that makes "tamper-evident" a checkable claim instead of an adjective: it is the
 * only reader of the chain, it never writes (the DB is opened read-only), and `npm run verify:ledger --
 * <db>` exits non-zero the moment a row was edited, deleted, reordered, truncated or forged in.
 *
 * Zero new dependencies — node:sqlite (built in) plus the engine's hash primitives.
 */
import { GENESIS, WHOLE_STORE, leafHash, entryHashFor, scopeRoot, type LedgerFacts } from "./ledger-chain";

export type FaultKind =
  | "unreadable" // the file isn't a readable receipt store
  | "no-chain" // the store predates the chain (or the chain was dropped wholesale)
  | "row-altered" // a row's contents no longer hash to its committed leaf
  | "chain-break" // a row's prevHash/entryHash doesn't link to the row before it
  | "missing-scope" // rows exist for a scope with no committed chain state
  | "uncommitted-row" // rows carrying NO chain commitment that the store never committed to
  | "count-mismatch" // the committed count doesn't match the rows that survive
  | "head-mismatch" // the committed head isn't the last entry in the chain
  | "root-mismatch"; // the committed Merkle root doesn't match the leaves it was sealed over

export interface LedgerFault {
  kind: FaultKind;
  /** Human-readable, LOCATED diagnosis — the line an operator reads at 3am. */
  detail: string;
  scope?: string;
  seq?: number;
  receiptId?: string;
  expected?: string;
  actual?: string;
}

export interface ScopeReport {
  /** "" is the whole store; anything else is that session's ledger. */
  scope: string;
  receipts: number;
  head: string;
  root: string;
  /** How many leaves the committed root was sealed over (<= receipts; the tail is chain-covered). */
  rootCount: number;
}

export interface LedgerReport {
  ok: boolean;
  path: string;
  receipts: number;
  scopes: ScopeReport[];
  faults: LedgerFault[];
}

interface RawStmt {
  all(...a: unknown[]): unknown[];
}
interface RawDb {
  prepare(sql: string): RawStmt;
  close(): void;
}
const NODE_SQLITE = "node:sqlite";

const REQUIRED_COLUMNS = ["seq", "leafHash", "prevHash", "entryHash"];

interface Row extends LedgerFacts {
  seq: number;
  leafHash: string;
  prevHash: string;
  entryHash: string;
}

const short = (h: string): string => (h.length > 16 ? `${h.slice(0, 16)}…` : h);

/** Verify a persisted receipt store. Never mutates it. */
export async function verifyLedger(path: string): Promise<LedgerReport> {
  const fail = (f: LedgerFault): LedgerReport => ({ ok: false, path, receipts: 0, scopes: [], faults: [f] });

  let db: RawDb;
  try {
    const { DatabaseSync } = (await import(NODE_SQLITE)) as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => RawDb;
    };
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare(`SELECT receiptId FROM receipts LIMIT 1`).all();
  } catch (e) {
    return fail({ kind: "unreadable", detail: `cannot read a receipt store at ${path}: ${(e as Error).message}` });
  }

  try {
    const columns = (db.prepare(`PRAGMA table_info(receipts)`).all() as Array<{ name?: unknown }>).map((c) => String(c.name));
    const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
    const hasChainState = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chain_state'`).all() as unknown[]
    ).length === 1;
    if (missing.length > 0 || !hasChainState) {
      return fail({
        kind: "no-chain",
        detail:
          `${path} carries no hash chain (missing ${[...missing, ...(hasChainState ? [] : ["table chain_state"])].join(", ")}) — ` +
          `its rows are NOT tamper-evident. Receipts written before the chain existed cannot be verified retroactively.`,
      });
    }

    const rows = (
      db
        .prepare(
          `SELECT receiptId, receiptHash, balanced, findingTypes, agent, merchant, deltaUsd, createdAt,
                  sessionKey, seq, leafHash, prevHash, entryHash FROM receipts
           WHERE leafHash IS NOT NULL ORDER BY seq ASC`,
        )
        .all() as Record<string, unknown>[]
    ).map(
      (o): Row => ({
        receiptId: String(o.receiptId),
        receiptHash: String(o.receiptHash),
        balanced: o.balanced === 1,
        findingTypes: o.findingTypes ? String(o.findingTypes).split(",").filter(Boolean) : [],
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

    const state = new Map<
      string,
      { head: string; count: number; root: string; rootCount: number; prunedHash: string; unchained: number }
    >();
    for (const s of db
      .prepare(`SELECT scope, head, count, root, rootCount, prunedHash, unchained FROM chain_state`)
      .all() as Record<string, unknown>[]) {
      state.set(String(s.scope), {
        head: String(s.head),
        count: Number(s.count),
        root: String(s.root),
        rootCount: Number(s.rootCount),
        prunedHash: String(s.prunedHash ?? ""),
        unchained: Number(s.unchained ?? 0),
      });
    }

    const faults: LedgerFault[] = [];
    const whole = state.get(WHOLE_STORE);
    if (!whole) {
      return fail({
        kind: "missing-scope",
        detail: `${path} has ${rows.length} receipts but no committed chain state for the store itself`,
      });
    }
    // ROWS THAT CARRY NO CHAIN COMMITMENT AT ALL. The walk below only sees rows WITH a leafHash, so a
    // row inserted with the chain columns left NULL is outside it by construction — the cheapest
    // possible forgery, and one that never has to touch chain_state. The committed `unchained` counter
    // cannot be the authority on how many such rows exist (an attacker who can INSERT can also leave
    // that counter alone), so RECOUNT them off the rows themselves and hold the counter to it.
    const uncommitted = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE leafHash IS NULL`).all() as Array<{ n?: unknown }>)[0]?.n ?? 0,
    );
    if (uncommitted !== whole.unchained) {
      const delta = Math.abs(uncommitted - whole.unchained);
      faults.push({
        kind: "uncommitted-row",
        scope: WHOLE_STORE,
        expected: String(whole.unchained),
        actual: String(uncommitted),
        detail:
          uncommitted > whole.unchained
            ? `${delta} row(s) carry no chain commitment beyond the ${whole.unchained} this store committed to — ` +
              `they were INSERTED with the chain columns left empty. An uncommitted row is not in the chain, so the ` +
              `chain walk cannot see it, but it is still served as a receipt: treat it as FORGED.`
            : `${delta} of the ${whole.unchained} uncommitted (pre-chain) row(s) this store committed to are GONE — ` +
              `they were deleted outside the store API, which does not decrement the counter behind its own back.`,
      });
    }
    // Receipts written before the chain existed. They are real records but they were never committed
    // to, so they cannot be certified — and a verifier that quietly passed them would be worse than no
    // verifier at all. Reported over the RECOUNTED number that is genuinely pre-chain (anything above
    // it is the forgery named above, and calling a forgery "pre-chain" would be its own small lie),
    // then the chained portion is still walked.
    const predateChain = Math.min(uncommitted, whole.unchained);
    if (predateChain > 0) {
      faults.push({
        kind: "no-chain",
        scope: WHOLE_STORE,
        detail:
          `${predateChain} receipt(s) predate the hash chain and carry no commitment — they are NOT ` +
          `tamper-evident and cannot be verified retroactively. Only the ${rows.length} chained receipts below are.`,
      });
    }

    // 1. WALK THE CHAIN. Stops at the first break: everything after it is derived from a link that
    //    no longer holds, so reporting the rest would be noise, not evidence.
    const beforeWalk = faults.length;
    const leavesByScope = new Map<string, string[]>([[WHOLE_STORE, []]]);
    let prev = whole.prunedHash || GENESIS;
    for (const r of rows) {
      const expectedLeaf = await leafHash(r);
      if (expectedLeaf !== r.leafHash) {
        faults.push({
          kind: "row-altered",
          scope: WHOLE_STORE,
          seq: r.seq,
          receiptId: r.receiptId,
          expected: r.leafHash,
          actual: expectedLeaf,
          detail:
            `seq ${r.seq} (${r.receiptId}): the row's contents no longer hash to its committed leaf ` +
            `(committed ${short(r.leafHash)}, contents hash to ${short(expectedLeaf)}) — this row was EDITED in place.`,
        });
        break;
      }
      const expectedEntry = await entryHashFor(prev, r.leafHash);
      if (r.prevHash !== prev || r.entryHash !== expectedEntry) {
        faults.push({
          kind: "chain-break",
          scope: WHOLE_STORE,
          seq: r.seq,
          receiptId: r.receiptId,
          expected: prev,
          actual: r.prevHash,
          detail:
            `seq ${r.seq} (${r.receiptId}): does not link to the entry before it ` +
            `(expected prevHash ${short(prev)}, found ${short(r.prevHash)}) — a row was DELETED, REORDERED or FORGED here.`,
        });
        break;
      }
      prev = r.entryHash;
      leavesByScope.get(WHOLE_STORE)!.push(r.leafHash);
      if (r.sessionKey) {
        const l = leavesByScope.get(r.sessionKey) ?? [];
        l.push(r.leafHash);
        leavesByScope.set(r.sessionKey, l);
      }
    }

    // 2. CHECK EVERY SCOPE'S COMMITMENT. This is what catches a truncation the chain can't see — a
    //    ledger with its newest rows lopped off is still a valid chain, just a short one.
    const scopes: ScopeReport[] = [];
    if (faults.length === beforeWalk) {
      for (const [scope, st] of [...state.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const leaves = leavesByScope.get(scope) ?? [];
        scopes.push({ scope, receipts: leaves.length, head: st.head, root: st.root, rootCount: st.rootCount });
        const where = scope === WHOLE_STORE ? "the store" : `session ${JSON.stringify(scope)}`;
        if (st.count !== leaves.length) {
          const missing = st.count - leaves.length;
          faults.push({
            kind: "count-mismatch",
            scope,
            expected: String(st.count),
            actual: String(leaves.length),
            detail:
              missing > 0
                ? `${where}: committed to ${st.count} receipts, ${leaves.length} survive — ${missing} were REMOVED.`
                : `${where}: committed to ${st.count} receipts but ${leaves.length} are present — ${-missing} were ` +
                  `INSERTED without the scope re-committing to them.`,
          });
          continue;
        }
        const expectedHead = leaves.length === 0 ? st.prunedHash || GENESIS : rowsInScope(rows, scope).at(-1)!.entryHash;
        if (st.head !== expectedHead) {
          faults.push({
            kind: "head-mismatch",
            scope,
            expected: st.head,
            actual: expectedHead,
            detail: `${where}: committed head ${short(st.head)} is not the last entry in the chain (${short(expectedHead)}).`,
          });
          continue;
        }
        if (st.rootCount > leaves.length) {
          faults.push({
            kind: "count-mismatch",
            scope,
            expected: String(st.rootCount),
            actual: String(leaves.length),
            detail: `${where}: the committed Merkle root was sealed over ${st.rootCount} leaves but only ${leaves.length} survive.`,
          });
          continue;
        }
        const expectedRoot = await scopeRoot(leaves.slice(0, st.rootCount));
        if (st.root !== expectedRoot) {
          faults.push({
            kind: "root-mismatch",
            scope,
            expected: st.root,
            actual: expectedRoot,
            detail:
              `${where}: the committed Merkle root over its first ${st.rootCount} receipts is ${short(st.root)}, ` +
              `but those receipts now root to ${short(expectedRoot)}.`,
          });
        }
      }
      // Rows belonging to a session that has no committed chain state at all.
      for (const scope of leavesByScope.keys()) {
        if (scope !== WHOLE_STORE && !state.has(scope)) {
          faults.push({
            kind: "missing-scope",
            scope,
            detail: `session ${JSON.stringify(scope)} has receipts but no committed chain state — its ledger was FORGED IN.`,
          });
        }
      }
    }

    return { ok: faults.length === 0, path, receipts: rows.length, scopes, faults };
  } finally {
    db.close();
  }
}

const rowsInScope = (rows: Row[], scope: string): Row[] =>
  scope === WHOLE_STORE ? rows : rows.filter((r) => r.sessionKey === scope);
