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
// MAX_POSITION is the WRITER's constant too (the store refuses to allocate past it) — one definition,
// so the reader and the writer cannot drift into disagreeing about where the edge is.
import { GENESIS, WHOLE_STORE, MAX_POSITION, leafHash, entryHashFor, scopeRoot, type LedgerFacts } from "./ledger-chain";
// Type-only: the anchor module imports verifyLedger, so a value import here would be a cycle.
import type { LedgerAnchor } from "./ledger-anchor";

export type FaultKind =
  | "unreadable" // the file isn't a readable receipt store
  | "no-chain" // the store predates the chain (or the chain was dropped wholesale)
  | "row-altered" // a row's contents no longer hash to its committed leaf
  | "chain-break" // a row's prevHash/entryHash doesn't link to the row before it
  | "missing-scope" // rows exist for a scope with no committed chain state
  | "phantom-scope" // a scope commits to zero receipts and has none — a claim nothing can contradict
  | "uncommitted-row" // rows carrying NO chain commitment that the store never committed to
  | "malformed-row" // a row is not the canonical encoding of the facts its leaf commits to
  | "malformed-state" // a committed counter is not a number a check can be run against
  | "count-mismatch" // the committed count doesn't match the rows that survive
  | "head-mismatch" // the committed head isn't the last entry in the chain
  | "root-mismatch" // the committed Merkle root doesn't match the leaves it was sealed over
  | "anchor-mismatch"; // self-consistent, but not the ledger the anchor committed to

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
  /**
   * Was this checked against an off-box anchor?
   *
   * A walk proves internal self-consistency, which a whole-ledger re-seal also satisfies. Without
   * an anchor, `ok: true` means "this file is consistent", NOT "this is the ledger you committed
   * to". The two readings are far apart, so the difference is a field rather than a footnote.
   */
  anchored: boolean;
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
  /** Non-empty when the STORED row is not the canonical encoding of the facts decoded above. */
  malformed: string[];
}

const short = (h: string): string => (h.length > 16 ? `${h.slice(0, 16)}…` : h);
const show = (v: unknown): string => (v === null ? "NULL" : v === undefined ? "absent" : JSON.stringify(String(v)));

/**
 * Decode one stored row into the facts its leaf commits to — and record every way the STORED row is
 * not the canonical encoding of those facts.
 *
 * This is the fail-closed half of the verifier, and it exists because the decode is otherwise
 * LOSSY: `balanced === 1` maps -1, 2 and "0" all to false; `split(",").filter(Boolean)` maps
 * ",OVERSPEND," and "OVERSPEND" to the same array; `Number("n/a")` is NaN and `canonicalJSON(NaN)`
 * is "null", so text in the money column hashes exactly like a committed null. Each of those means
 * two DIFFERENT stored rows share one leaf — so "the leaf matches" would stop implying "the row is
 * what was committed", which is the entire proposition. Making the decode injective restores it.
 */
function decodeRow(o: Record<string, unknown>): Row {
  const malformed: string[] = [];

  if (o.balanced !== 0 && o.balanced !== 1) {
    malformed.push(`balanced is ${show(o.balanced)}, which is not a verdict (every reader coerces it differently)`);
  }
  const rawTypes = o.findingTypes === null || o.findingTypes === undefined ? "" : String(o.findingTypes);
  const findingTypes = rawTypes ? rawTypes.split(",").filter(Boolean) : [];
  if (findingTypes.join(",") !== rawTypes) {
    malformed.push(`findingTypes ${JSON.stringify(rawTypes)} is not the canonical encoding of ${JSON.stringify(findingTypes)}`);
  }
  const deltaUsd = o.deltaUsd === null || o.deltaUsd === undefined ? null : Number(o.deltaUsd);
  if (deltaUsd !== null && !Number.isFinite(deltaUsd)) {
    malformed.push(`deltaUsd is ${show(o.deltaUsd)}, which is not a number — it would hash as the committed null`);
  }
  const createdAt = Number(o.createdAt);
  if (!Number.isFinite(createdAt)) malformed.push(`createdAt is ${show(o.createdAt)}, which is not a timestamp`);
  const seq = Number(o.seq);
  if (o.seq === null || o.seq === undefined || !Number.isInteger(seq)) {
    malformed.push(`seq is ${show(o.seq)}, which is not a position in the chain`);
  }

  return {
    receiptId: String(o.receiptId),
    receiptHash: String(o.receiptHash),
    balanced: o.balanced === 1,
    findingTypes,
    agent: String(o.agent),
    merchant: String(o.merchant),
    deltaUsd,
    createdAt,
    sessionKey: o.sessionKey === null || o.sessionKey === undefined ? undefined : String(o.sessionKey),
    seq,
    leafHash: String(o.leafHash),
    prevHash: String(o.prevHash),
    entryHash: String(o.entryHash),
    malformed,
  };
}

/**
 * Diagnose a row read that failed before any row could be decoded. The only known cause is a `seq`
 * outside the safe-integer range, so look for exactly that — as TEXT, so the diagnosis itself cannot
 * hit the same wall — and fall back to naming the raw failure rather than guessing.
 */
function unreadablePositions(db: RawDb, cause: Error): LedgerFault {
  let offenders: Array<{ receiptId?: unknown; seqText?: unknown }> = [];
  try {
    // The bound is this module's own constant, never caller-supplied, and it is inlined rather than
    // bound as a parameter deliberately: a bound JS number could reach sqlite as a double, and the
    // whole point of this query is to compare int64s exactly at the edge of what a double can hold.
    offenders = db
      .prepare(
        `SELECT receiptId, CAST(seq AS TEXT) AS seqText FROM receipts
         WHERE seq > ${MAX_POSITION} OR seq < ${-MAX_POSITION} ORDER BY seq ASC`,
      )
      .all() as Array<{ receiptId?: unknown; seqText?: unknown }>;
  } catch {
    offenders = [];
  }
  if (offenders.length === 0) {
    return { kind: "unreadable", detail: `${cause.message} — the receipts of this store could not be read` };
  }
  const first = offenders[0];
  return {
    kind: "malformed-row",
    scope: WHOLE_STORE,
    receiptId: String(first.receiptId),
    expected: `a position within ±${MAX_POSITION}`,
    actual: String(first.seqText),
    detail:
      `seq ${String(first.seqText)} (${String(first.receiptId)}): outside the range a position can be read in — ` +
      `${offenders.length} row(s) are. The ledger cannot be walked at all, and the store cannot append to it either ` +
      `(its allocator refuses to hand out a position it could not read back), so every receipt in it is ` +
      `unattested until they are restored.`,
  };
}

/** A committed counter, or null when it is not a number a check could be run against. */
const counter = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Verify a persisted receipt store. Never mutates it. */
export async function verifyLedger(
  path: string,
  opts: { anchor?: LedgerAnchor } = {},
): Promise<LedgerReport> {
  const anchored = opts.anchor !== undefined;
  const fail = (f: LedgerFault): LedgerReport => ({
    ok: false,
    path,
    receipts: 0,
    scopes: [],
    faults: [f],
    anchored,
  });

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

    // THE ROW READ CAN FAIL BEFORE A ROW EXISTS TO INSPECT. `seq` is a sqlite INTEGER (int64) but it
    // is read into a JS number, and node:sqlite refuses to narrow a value wider than a double — it
    // throws inside `.all()`. `decodeRow` therefore CANNOT reach this case: there is nothing decoded
    // yet. Left uncaught the whole verifier throws, and a verifier that dies is not the same thing as
    // a verifier that reports: the CLI would print a bare "Value is too large…" naming no row, and a
    // programmatic caller (the tamper drill runs a whole registry through this function) would abort
    // mid-run. So catch it and LOCATE it — the offending positions are re-read as TEXT, which never
    // crosses the number boundary at all.
    let rows: Row[];
    try {
      rows = (
        db
          .prepare(
            `SELECT receiptId, receiptHash, balanced, findingTypes, agent, merchant, deltaUsd, createdAt,
                  sessionKey, seq, leafHash, prevHash, entryHash FROM receipts
           WHERE leafHash IS NOT NULL ORDER BY seq ASC`,
          )
          .all() as Record<string, unknown>[]
      ).map(decodeRow);
    } catch (e) {
      return { ok: false, path, receipts: 0, scopes: [], faults: [unreadablePositions(db, e as Error)], anchored };
    }

    // THE COMMITTED COUNTERS, VALIDATED BEFORE ANYTHING IS INFERRED FROM THEM. Every one of these
    // GATES a check — `rootCount` decides how many leaves the root is compared over — and a gate that
    // cannot be parsed must FAIL, never be skipped: `NaN > n` is false (reads as "in range") and
    // `leaves.slice(0, -9)` silently yields [] (reads as "the empty root, which matches"). Two columns
    // of UPDATE would otherwise retire a scope's inclusion commitment while the CLI printed VERIFIED.
    const state = new Map<
      string,
      { head: string; count: number; root: string; rootCount: number; prunedHash: string; unchained: number }
    >();
    const malformedState: LedgerFault[] = [];
    for (const s of db
      .prepare(`SELECT scope, head, count, root, rootCount, prunedHash, unchained FROM chain_state`)
      .all() as Record<string, unknown>[]) {
      const scope = String(s.scope);
      const where = scope === WHOLE_STORE ? "the store" : `session ${JSON.stringify(scope)}`;
      const [count, rootCount, unchained] = [counter(s.count), counter(s.rootCount), counter(s.unchained ?? 0)];
      for (const [field, raw, parsed] of [
        ["count", s.count, count],
        ["rootCount", s.rootCount, rootCount],
        ["unchained", s.unchained, unchained],
      ] as const) {
        if (parsed === null) {
          malformedState.push({
            kind: "malformed-state",
            scope,
            actual: show(raw),
            detail:
              `${where}: committed ${field} is ${show(raw)}, not a count — every check this gates would be ` +
              `SKIPPED rather than failed, so the commitment is treated as unverifiable.`,
          });
        }
      }
      if (count !== null && rootCount !== null && rootCount > count) {
        malformedState.push({
          kind: "malformed-state",
          scope,
          expected: `rootCount <= ${count}`,
          actual: String(rootCount),
          detail: `${where}: the Merkle root claims to be sealed over ${rootCount} leaves but the scope commits to only ${count}.`,
        });
      }
      state.set(scope, {
        head: String(s.head),
        count: count ?? Number.NaN,
        root: String(s.root),
        rootCount: rootCount ?? Number.NaN,
        prunedHash: String(s.prunedHash ?? ""),
        unchained: unchained ?? Number.NaN,
      });
    }
    if (malformedState.length > 0) {
      return { ok: false, path, receipts: rows.length, scopes: [], faults: malformedState, anchored };
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
    let lastSeq = 0;
    for (const r of rows) {
      if (r.malformed.length > 0) {
        faults.push({
          kind: "malformed-row",
          scope: WHOLE_STORE,
          seq: r.seq,
          receiptId: r.receiptId,
          detail: `seq ${r.seq} (${r.receiptId}): ${r.malformed.join("; ")} — a row that is not the canonical encoding of its facts cannot be certified by its leaf.`,
        });
        break;
      }
      // THE WALK'S ORDER IS `seq`, so `seq` has to be an order. Two rows sharing a position are
      // separated by whatever tie-break the engine feels like today (rowid, until a VACUUM), which
      // means the chain would be validated against an order nobody committed to — and `seq` is also
      // what bounded retention deletes by, so a collision lets an attacker choose which row the next
      // legitimate prune destroys, and the prune records itself as legitimate.
      if (!(r.seq > lastSeq)) {
        faults.push({
          kind: "malformed-row",
          scope: WHOLE_STORE,
          seq: r.seq,
          receiptId: r.receiptId,
          expected: `a position greater than ${lastSeq}`,
          actual: String(r.seq),
          detail:
            `seq ${r.seq} (${r.receiptId}): does not follow the row before it (position ${lastSeq}) — the chain's ` +
            `order would depend on a tie-break, not on what was committed.`,
        });
        break;
      }
      lastSeq = r.seq;
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
        // A SCOPE THAT COMMITS TO NOTHING. Every check above is relative to the scope's own claim, and
        // a claim of "no receipts" is trivially satisfiable — count 0, head genesis, the empty root.
        // The store never produces one for a session (a prune deletes a session's chain state when its
        // last row goes), so a zero-receipt session ledger can only have been forged in. The whole
        // store is exempt: an empty store is a real, legitimate state.
        if (scope !== WHOLE_STORE && leaves.length === 0) {
          faults.push({
            kind: "phantom-scope",
            scope,
            detail:
              `${where}: commits to zero receipts and has none — a claim nothing can contradict. The store deletes a ` +
              `session's chain state when its last row is pruned, so this ledger was FORGED IN.`,
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

    if (opts.anchor) {
      const whole = scopes.find((s) => s.scope === WHOLE_STORE);
      const a = opts.anchor;
      const diffs: string[] = [];
      if (!whole) {
        diffs.push(`the store has no whole-store commitment at all, but the anchor commits to ${a.count} receipt(s)`);
      } else {
        if (whole.root !== a.root) diffs.push(`root ${whole.root} is not the anchored ${a.root}`);
        if (whole.head !== a.head) diffs.push(`head ${whole.head} is not the anchored ${a.head}`);
        if (whole.receipts !== a.count) diffs.push(`${whole.receipts} receipt(s) present, anchor commits to ${a.count}`);
      }
      if (diffs.length > 0) {
        faults.push({
          kind: "anchor-mismatch",
          scope: WHOLE_STORE,
          detail:
            `the file is self-consistent but it is NOT the ledger anchored at ${a.sealedAt}: ` +
            diffs.join('; ') +
            `. A whole-ledger re-seal produces exactly this: a valid record of a different history.`,
          expected: a.root,
          actual: whole?.root ?? "(none)",
        });
      }
    }

    return { ok: faults.length === 0, path, receipts: rows.length, scopes, faults, anchored };
  } finally {
    db.close();
  }
}

const rowsInScope = (rows: Row[], scope: string): Row[] =>
  scope === WHOLE_STORE ? rows : rows.filter((r) => r.sessionKey === scope);
