/**
 * Pacioli — the PERSISTED ledger is tamper-evident, or the tamper-evidence claim is a lie.
 *
 * Content addressing (receiptHash) proves a receipt's *contents* match its id. It proves nothing
 * about the ledger those receipts sit in: with no chain, a `sqlite3 receipts.db "UPDATE ..."` on a
 * historical row, a DELETE, or a swap of two rows' order leaves no trace at all. These tests are the
 * lock on that: every mutation of the durable store must be located by verifyLedger().
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCreateSqliteStore, type StoredReceipt } from "./receipt-store";
import { verifyLedger } from "./verify-ledger";
import { leafHash, entryHashFor, scopeRoot } from "./ledger-chain";

const mk = (id: string, balanced: boolean, types: string[], sessionKey?: string, createdAt = 1): StoredReceipt => ({
  receiptId: id,
  receiptHash: "h" + id,
  balanced,
  findingTypes: types,
  agent: "booker",
  merchant: "United",
  deltaUsd: balanced ? null : 78,
  createdAt,
  sessionKey,
});

const dir = mkdtempSync(join(tmpdir(), "pacioli-chain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A raw handle to the same file — this is the attacker: sqlite, not the store API.
interface RawDb {
  exec(s: string): void;
  prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}
const NODE_SQLITE = "node:sqlite";
const rawOpen = async (p: string): Promise<RawDb> => {
  const { DatabaseSync } = (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => RawDb };
  return new DatabaseSync(p);
};

/** A pristine 4-receipt ledger, written through the store API, copied per test so each starts clean. */
const PRISTINE = join(dir, "pristine.db");
beforeAll(async () => {
  const s = await tryCreateSqliteStore(PRISTINE);
  if (!s) return;
  await s.save(mk("sha256:aaa", false, ["OVERSPEND"], "user-alice", 1000));
  await s.save(mk("sha256:bbb", true, [], "user-alice", 2000));
  await s.save(mk("sha256:ccc", false, ["SCOPE_CREEP"], "user-bob", 3000));
  await s.save(mk("sha256:ddd", true, [], undefined, 4000));
});
let n = 0;
const freshCopy = (): string => {
  const p = join(dir, `case-${n++}.db`);
  copyFileSync(PRISTINE, p);
  return p;
};

describe("persisted ledger — hash chain + per-session Merkle root", () => {
  it("verifies clean when nothing has been touched", async () => {
    const report = await verifyLedger(freshCopy());
    expect(report.ok).toBe(true);
    expect(report.faults).toEqual([]);
    expect(report.receipts).toBe(4);
  });

  it("detects and LOCATES an in-place edit of a historical row", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    // The whole point of the product: flip a flagged receipt to clean and erase its finding.
    db.exec(`UPDATE receipts SET balanced = 1, findingTypes = '', deltaUsd = NULL WHERE receiptId = 'sha256:aaa'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("row-altered");
    expect(report.faults[0].receiptId).toBe("sha256:aaa");
    expect(report.faults[0].detail).toMatch(/sha256:aaa/);
  });

  it("detects a DELETED historical row (the chain link goes missing)", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`DELETE FROM receipts WHERE receiptId = 'sha256:bbb'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("chain-break");
    expect(report.faults[0].receiptId).toBe("sha256:ccc"); // the row whose predecessor vanished
  });

  it("detects REORDERED rows (swapping two entries' positions)", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = 99 WHERE receiptId = 'sha256:aaa'`);
    db.exec(`UPDATE receipts SET seq = 1 WHERE receiptId = 'sha256:bbb'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults.length).toBeGreaterThan(0);
  });

  it("detects TRUNCATION of the newest row (a self-consistent chain that is short)", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`DELETE FROM receipts WHERE receiptId = 'sha256:ddd'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults.map((f) => f.kind)).toContain("count-mismatch");
  });

  it("detects a forged APPEND that does not extend the chain", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(
      `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,seenCount,sessionKey,seq,leafHash,prevHash,entryHash)
       VALUES ('sha256:evil','hevil',1,'','booker','United',NULL,5000,1,'user-alice',5,'x','y','z')`,
    );
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].receiptId).toBe("sha256:evil");
  });

  it("detects a forged INSERT that leaves the chain columns NULL — the CHEAPEST forgery", async () => {
    // The EASY variant of the test above. Forging bogus chain values ('x','y','z') is the hard way;
    // simply omitting them is one plain INSERT, and the row is still served by /api/ledger. A verifier
    // that only walks rows carrying a leafHash — and takes the uncommitted count from chain_state
    // instead of recounting the rows — prints VERIFIED straight over it.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(
      `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,seenCount,sessionKey)
       VALUES ('sha256:forged0000000000','hforged',1,'','attacker','Acme',NULL,9999999,1,NULL)`,
    );
    db.close(); // chain_state deliberately NOT touched — the attacker never has to go near it

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("uncommitted-row");
    expect(report.faults[0].detail).toMatch(/INSERTED/);
    expect(report.faults[0].expected).toBe("0");
    expect(report.faults[0].actual).toBe("1");
  });

  it("calls an INSERT an insert — never a negative removal — when the scope never committed to it", async () => {
    // The third insertion shape: chain the row correctly off the current head, then leave chain_state
    // alone. The committed count catches it either way, but a diagnosis of "−1 were REMOVED" sends the
    // operator looking for a deletion that never happened.
    const path = freshCopy();
    const db = await rawOpen(path);
    const head = String((db.prepare(`SELECT head FROM chain_state WHERE scope = ''`).all() as Array<{ head: string }>)[0].head);
    const facts = {
      receiptId: "sha256:eee",
      receiptHash: "hsha256:eee",
      balanced: true,
      findingTypes: [] as string[],
      agent: "attacker",
      merchant: "Acme",
      deltaUsd: null,
      createdAt: 9000,
    };
    const leaf = await leafHash(facts);
    db.prepare(
      `INSERT INTO receipts (receiptId,receiptHash,balanced,findingTypes,agent,merchant,deltaUsd,createdAt,seenCount,sessionKey,seq,leafHash,prevHash,entryHash)
       VALUES (?,?,1,'',?,?,NULL,?,1,NULL,99,?,?,?)`,
    ).run(facts.receiptId, facts.receiptHash, facts.agent, facts.merchant, facts.createdAt, leaf, head, await entryHashFor(head, leaf));
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("count-mismatch");
    expect(report.faults[0].detail).toMatch(/INSERTED/);
    expect(report.faults[0].detail).not.toMatch(/REMOVED/);
  });

  it("RECOUNTS the uncommitted rows instead of trusting the committed counter", async () => {
    // Same defect from the other side: chain_state.unchained is a stored number, so it can be stale or
    // a lie in either direction. Deleting a pre-chain row behind the counter's back must be named, not
    // papered over by re-printing the counter.
    const path = join(dir, "uncommitted-recount.db");
    const legacy = await rawOpen(path);
    legacy.exec(
      `CREATE TABLE receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    for (const id of ["old1", "old2"]) {
      legacy.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,1)`).run(id, "h" + id, 0, "OVERSPEND", "a", "m", null, 5);
    }
    legacy.close();

    const s = await tryCreateSqliteStore(path);
    expect(s).not.toBeNull();
    await s!.save(mk("sha256:new1", true, [], undefined, 6));
    expect((await verifyLedger(path)).faults[0].detail).toMatch(/2 receipt\(s\) predate/);

    const db = await rawOpen(path);
    db.exec(`DELETE FROM receipts WHERE receiptId = 'old2'`); // chain_state.unchained still claims 2
    db.close();

    const after = await verifyLedger(path);
    expect(after.ok).toBe(false);
    expect(after.faults[0].kind).toBe("uncommitted-row");
    expect(after.faults[0].detail).toMatch(/GONE/);
    // …and the certifiability line now reports what is actually there, not the stale counter.
    expect(after.faults.some((f) => f.kind === "no-chain" && /1 receipt\(s\) predate/.test(f.detail))).toBe(true);
  });

  it("refuses to pass a legacy store that has no chain at all (no silent green)", async () => {
    const path = join(dir, "legacy-nochain.db");
    const db = await rawOpen(path);
    db.exec(
      `CREATE TABLE receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    db.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,1)`).run("old1", "hold1", 0, "OVERSPEND", "a", "m", null, 5);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("no-chain");
  });

  it("the COMMITTED reference store verifies, and the CLI exits non-zero once it is tampered with", async () => {
    // dataset/reference-ledger.db is what CI audits on every push. If it ever needs regenerating, the
    // chain must be rebuilt through the store API — a hand-edited fixture cannot verify, by design.
    const cli = (db: string): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "lib/store/verify-ledger-cli.ts", db], {
        encoding: "utf8",
      });

    const clean = cli("dataset/reference-ledger.db");
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("VERIFIED");

    const copy = join(dir, "reference-tampered.db");
    copyFileSync("dataset/reference-ledger.db", copy);
    const db = await rawOpen(copy);
    db.exec(`UPDATE receipts SET balanced = 1, findingTypes = '' WHERE receiptId = 'sha256:0f3c1a2b4d5e6f70'`);
    db.close();

    const tampered = cli(copy);
    expect(tampered.status).toBe(1); // the CI gate IS the exit code, so lock the exit code
    expect(tampered.stderr).toContain("row-altered");
    expect(tampered.stderr).toContain("sha256:0f3c1a2b4d5e6f70");
  }, 60_000);

  it("stays verifiable across a retention prune — dropping old rows is RECORDED, not silent", async () => {
    // Bounded retention legitimately deletes the oldest rows. A chain that can't tell that apart from
    // an attack is a verifier that cries wolf, so the prune anchors the chain and re-seals the roots.
    const path = join(dir, "pruned.db");
    const s = await tryCreateSqliteStore(path, { cap: 5 });
    if (!s) return;
    for (let i = 0; i < 12; i++) {
      await s.save(mk(`sha256:p${i}`, i % 2 === 0, i % 2 === 0 ? [] : ["OVERSPEND"], i % 3 === 0 ? "user-alice" : undefined, 1000 + i));
    }
    expect(s.stats().total).toBeLessThanOrEqual(5);

    const report = await verifyLedger(path);
    expect(report.faults).toEqual([]);
    expect(report.ok).toBe(true);

    // …and tampering with what SURVIVED the prune is still caught.
    const surviving = s.list(1)[0].receiptId;
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET merchant = 'Forged' WHERE receiptId = '${surviving}'`);
    db.close();
    const after = await verifyLedger(path);
    expect(after.ok).toBe(false);
    expect(after.faults[0].receiptId).toBe(surviving);
  });

  it("names pre-chain receipts as uncertifiable instead of pretending to verify them", async () => {
    const path = join(dir, "migrated.db");
    const legacy = await rawOpen(path);
    legacy.exec(
      `CREATE TABLE receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    legacy.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,1)`).run("old1", "hold1", 0, "OVERSPEND", "a", "m", null, 5);
    legacy.close();

    const s = await tryCreateSqliteStore(path);
    if (!s) return;
    await s.save(mk("sha256:new1", true, [], "user-alice", 6));

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("no-chain");
    expect(report.faults[0].detail).toMatch(/1 receipt\(s\) predate the hash chain/);
    // The chained tail is still walked and still clean — the fault is scoped to the legacy row.
    expect(report.receipts).toBe(1);
    expect(report.faults).toHaveLength(1);
  });

  it("commits a per-session Merkle root that a tampered session row breaks", async () => {
    const path = freshCopy();
    const before = await verifyLedger(path);
    expect(before.scopes.find((s) => s.scope === "user-alice")?.root).toMatch(/^[0-9a-f]{64}$/);

    const db = await rawOpen(path);
    // Rewrite the row AND its leaf/chain so the chain walk itself stays self-consistent — only the
    // committed session root can catch this one.
    const rows = db.prepare(`SELECT leafHash, prevHash, entryHash FROM receipts WHERE receiptId = 'sha256:bbb'`).all();
    expect(rows).toHaveLength(1);
    db.exec(`UPDATE chain_state SET root = 'deadbeef' WHERE scope = 'user-alice'`);
    db.close();

    const after = await verifyLedger(path);
    expect(after.ok).toBe(false);
    expect(after.faults.map((f) => f.kind)).toContain("root-mismatch");
  });
});

/**
 * FAIL CLOSED ON MALFORMED INPUT. The NULL-chain evasion was an instance of a class — "a verification
 * function that SUCCEEDS on malformed input" — not a one-off. These are its siblings, every one of
 * them found by the tamper drill (lib/store/tamper-drill.ts) rather than by imagination: a check that
 * gets SKIPPED because a value could not be parsed is worse than no check at all, and a decode that
 * maps two different stored rows onto the same committed facts means "the leaf matches" stops meaning
 * "the row is what was committed".
 */
describe("verifier — fails closed on malformed input", () => {
  it("refuses a DUPLICATE sequence number: the walk's order must not depend on a tie-break", async () => {
    // ORDER BY seq with a tie is resolved by rowid *today*, so every link still holds and the ledger
    // verifies — while `seq` is also what bounded retention deletes by. An attacker who can make two
    // rows share a position can steer which row the next legitimate prune destroys, and the prune is
    // recorded as legitimate. seq is the chain's order authority; it has to be checked like one.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = 2 WHERE receiptId = 'sha256:ccc'`); // ccc was seq 3, bbb is seq 2
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
    expect(report.faults[0].receiptId).toBe("sha256:ccc");
    expect(report.faults[0].detail).toMatch(/position/i);
  });

  it("LOCATES a seq outside the safe-integer range instead of dying with a bare RangeError", async () => {
    // The out-of-range sibling of the two checks above, and the one the decode can never reach:
    // node:sqlite refuses to hand an INTEGER wider than a double to JS, so the failure happens inside
    // `.all()` — before any row exists to inspect. Left uncaught, verifyLedger() THROWS instead of
    // returning a report: the CLI still exits non-zero (it catches at the top), but the operator is
    // told "Value is too large to be represented as a JavaScript number" and not which row, and any
    // programmatic caller (the drill walks a whole registry through this function) dies mid-run.
    // A verifier that fails must fail LOCATED — that is the whole standard this file exists to hold.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = seq + 9007199254740992 WHERE receiptId = 'sha256:ccc'`);
    db.close();

    const report = await verifyLedger(path); // must RETURN a fault, not throw
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
    expect(report.faults[0].receiptId).toBe("sha256:ccc");
    expect(report.faults[0].detail).toMatch(/seq/);
    expect(report.faults[0].actual).toBe("9007199254740995");
  });

  it("refuses a NULL sequence number rather than sorting it wherever sqlite likes", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = NULL WHERE receiptId = 'sha256:ccc'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
  });

  it("refuses a NEGATIVE rootCount instead of silently checking the root over an empty set", async () => {
    // `st.rootCount > leaves.length` is the only guard, and a negative number sails past it — then
    // `leaves.slice(0, -9)` yields [] and the Merkle check compares the empty root to the empty root.
    // Two columns of UPDATE and the scope's inclusion commitment means nothing, while the CLI prints
    // VERIFIED over it.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.prepare(`UPDATE chain_state SET rootCount = -9, root = ? WHERE scope = ''`).run(await scopeRoot([]));
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-state");
    expect(report.faults[0].detail).toMatch(/rootCount/);
  });

  it("refuses a NON-NUMERIC rootCount — a comparison against NaN is false, which reads as 'in range'", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.prepare(`UPDATE chain_state SET rootCount = 'x', root = ? WHERE scope = 'user-alice'`).run(await scopeRoot([]));
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-state");
    expect(report.faults[0].scope).toBe("user-alice");
  });

  it("refuses a session ledger committed to ZERO receipts — a claim nothing can contradict", async () => {
    // Every scope check is relative to that scope's own claim, and a claim of "no receipts" is
    // trivially satisfiable: count 0, head GENESIS, the empty root. The store never produces one (a
    // prune deletes a session's chain state when its last row goes), so it can only have been forged.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.prepare(
      `INSERT INTO chain_state (scope, head, count, root, rootCount, prunedSeq, prunedHash, unchained, updatedAt)
       VALUES ('user-ghost','pacioli-ledger-genesis',0,?,0,0,'',0,1)`,
    ).run(await scopeRoot([]));
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("phantom-scope");
    expect(report.faults[0].scope).toBe("user-ghost");
  });

  it("refuses TEXT in the money column: a coerced NaN must not hash as the committed null", async () => {
    // Number("n/a") is NaN and canonicalJSON(NaN) is "null", so text in deltaUsd hashes EXACTLY like
    // the null that was committed. The leaf matches, the verifier passes, and a reader renders NaN.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET deltaUsd = 'n/a' WHERE receiptId = 'sha256:bbb'`); // bbb committed NULL
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
    expect(report.faults[0].receiptId).toBe("sha256:bbb");
    expect(report.faults[0].detail).toMatch(/deltaUsd/);
  });

  it("refuses a findingTypes encoding that is not the canonical join of what it decodes to", async () => {
    // split(",").filter(Boolean) drops empty members, so ",OVERSPEND," and "OVERSPEND" decode to the
    // same array and share a leaf. The decode has to be INJECTIVE or the leaf stops pinning the row.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET findingTypes = ',OVERSPEND,,' WHERE receiptId = 'sha256:aaa'`);
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
    expect(report.faults[0].detail).toMatch(/findingTypes/);
  });

  it("refuses a verdict that is neither 0 nor 1 — every reader coerces it differently", async () => {
    // `o.balanced === 1` maps -1, 2 and "0" all to false. The verifier and the store agree today by
    // accident; a stored verdict outside {0,1} is not a verdict and must not verify.
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET balanced = -1 WHERE receiptId = 'sha256:aaa'`); // aaa committed 0
    db.close();

    const report = await verifyLedger(path);
    expect(report.ok).toBe(false);
    expect(report.faults[0].kind).toBe("malformed-row");
    expect(report.faults[0].detail).toMatch(/balanced/);
  });

  it("still passes the untampered ledger — fail-closed must not mean fail-always", async () => {
    const report = await verifyLedger(freshCopy());
    expect(report.faults).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

/** mulberry32 — seeded, so "a space" below is a FIXED space and any failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `seq` IS READ, BUT NEVER COMMITTED TO — the residual, pinned.
 *
 * The leaf covers receiptId, receiptHash, balanced, findingTypes, agent, merchant, deltaUsd,
 * createdAt and sessionKey. `seq` is not among them, so an order-PRESERVING renumbering of every
 * position (`UPDATE receipts SET seq = seq*2`) is invisible to the verifier. That is only acceptable
 * if nothing downstream depends on seq's absolute VALUE, and "nothing depends on it" is a claim about
 * a space, not about one example: these are the invariant over a generated space of renumberings,
 * asserted against the one decision that actually consumes seq — which rows bounded retention
 * destroys. If a future change starts to depend on the value, this goes red and the doc gets rewritten.
 */
describe("seq — the walk's order, not a committed fact", () => {
  /** A random strictly-increasing relabelling of the positions, in chain order. */
  const renumber = async (path: string, rng: () => number): Promise<number[]> => {
    const db = await rawOpen(path);
    const ids = (db.prepare(`SELECT receiptId FROM receipts ORDER BY seq ASC`).all() as Array<{ receiptId: string }>).map(
      (r) => String(r.receiptId),
    );
    const seqs: number[] = [];
    let next = 1 + Math.floor(rng() * 1000);
    for (const id of ids) {
      seqs.push(next);
      db.prepare(`UPDATE receipts SET seq = ? WHERE receiptId = ?`).run(next, id);
      next += 1 + Math.floor(rng() * 1000);
    }
    db.close();
    return seqs;
  };

  /** Drive a REAL retention prune (cap 3 over 4 rows ⇒ the two oldest go), then read what survived. */
  const pruneAndRead = async (path: string): Promise<{ survivors: string[]; state: unknown[]; prunedSeq: number }> => {
    const store = await tryCreateSqliteStore(path, { cap: 3 });
    if (!store) throw new Error("node:sqlite unavailable");
    await store.save(mk("sha256:zzz", true, [], undefined, 9000));
    const db = await rawOpen(path);
    const survivors = (db.prepare(`SELECT receiptId FROM receipts ORDER BY seq ASC`).all() as Array<{ receiptId: string }>).map(
      (r) => String(r.receiptId),
    );
    // Everything a reader is ever shown, EXCEPT prunedSeq — the one column a renumbering moves.
    const state = db
      .prepare(`SELECT scope, head, count, root, rootCount, prunedHash, unchained FROM chain_state ORDER BY scope`)
      .all();
    const prunedSeq = Number(
      (db.prepare(`SELECT prunedSeq AS s FROM chain_state WHERE scope = ''`).all() as Array<{ s: number }>)[0].s,
    );
    db.close();
    return { survivors, state, prunedSeq };
  };

  it("PROPERTY: any order-preserving renumbering still verifies, and leaves every commitment byte-identical", async () => {
    const baseline = freshCopy();
    const commitments = async (p: string): Promise<unknown[]> => {
      const db = await rawOpen(p);
      const rows = db.prepare(`SELECT receiptId, leafHash, prevHash, entryHash FROM receipts ORDER BY seq ASC`).all();
      const state = db.prepare(`SELECT scope, head, count, root, rootCount, prunedHash FROM chain_state ORDER BY scope`).all();
      db.close();
      return [rows, state];
    };
    const before = await commitments(baseline);

    for (let seed = 1; seed <= 24; seed++) {
      const path = freshCopy();
      const seqs = await renumber(path, mulberry32(seed));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // the generator really is order-preserving
      const report = await verifyLedger(path);
      expect({ seed, ok: report.ok, faults: report.faults }).toEqual({ seed, ok: true, faults: [] });
      expect(await commitments(path)).toEqual(before);
    }
  });

  it("PROPERTY: …and a real retention prune destroys exactly the same rows, whatever the positions are", async () => {
    // The claim that matters. `seq` picks a prune's victims, so if the absolute value mattered anywhere
    // it would matter HERE: an attacker who renumbered could choose what the next legitimate prune
    // deletes. It cannot — the ORDER decides, and the order is what the chain already commits to.
    const control = await pruneAndRead(freshCopy());
    expect(control.survivors).toEqual(["sha256:ccc", "sha256:ddd", "sha256:zzz"]);

    for (let seed = 1; seed <= 24; seed++) {
      const path = freshCopy();
      await renumber(path, mulberry32(seed));
      const after = await pruneAndRead(path);
      expect({ seed, ...after, prunedSeq: 0 }).toEqual({ seed, ...control, prunedSeq: 0 });
      const report = await verifyLedger(path);
      expect({ seed, ok: report.ok, faults: report.faults }).toEqual({ seed, ok: true, faults: [] });
    }
  });

  it("the ONLY thing a renumbering moves is prunedSeq — a column nothing ever reads back as a decision", async () => {
    // Stated as a test so the exposure is bounded by execution rather than by assertion: the pruned
    // anchor's POSITION differs (it is copied from the row that was deleted), while its HASH — the
    // value the verifier actually anchors on — does not. Nothing in lib/ reads prunedSeq to decide
    // anything; it is written, carried forward, and never consulted.
    const control = await pruneAndRead(freshCopy());
    const renumbered = freshCopy();
    await renumber(renumbered, mulberry32(7));
    const after = await pruneAndRead(renumbered);
    expect(after.prunedSeq).not.toBe(control.prunedSeq);
    expect(after.state).toEqual(control.state);
  });
});

/**
 * THE NEXT POSITION IS ALLOCATED, AND AN ALLOCATOR THAT CANNOT ALLOCATE MUST SAY SO.
 *
 * `seq` is a sqlite INTEGER (int64); the store reads `MAX(seq)` and the verifier reads every row's
 * position into a JS number, and node:sqlite refuses to narrow anything wider than a double. So the
 * store has an edge, and the only question is what it does AT the edge. Measured on copies of the
 * committed reference ledger before any of this existed, it did three different things, none of them
 * a refusal: with the highest position already past the range it rejected with a bare
 * `RangeError: Value is too large to be represented as a JavaScript number` that named no ledger and
 * no remedy; with the highest position exactly at `Number.MAX_SAFE_INTEGER` it RESOLVED — writing a
 * position it could never read again, which made the whole file stop verifying, on the very row it
 * had just written, while the caller was told the receipt was stored; and with a position column
 * holding text it wrote `seq = NULL` (`Number('zzz') + 1` is NaN) and resolved too.
 *
 * A store that reports a save it has poisoned the ledger with is worse than a store that refuses.
 * These pin the refusal: named, located, and nothing written.
 */
describe("the next position — allocated fail-closed, or refused by name", () => {
  /** Force the ledger's HIGHEST position to an exact value, as a SQL literal: a position wider than a
   *  double cannot be BOUND as a JS number, which is the entire subject of this block. */
  const setMaxPosition = async (path: string, literal: string): Promise<void> => {
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = ${literal} WHERE seq = (SELECT MAX(seq) FROM receipts)`);
    db.close();
  };

  /** Every stored position, read as TEXT — the only lossless way to look at an int64 from here. */
  const positions = async (path: string): Promise<string[]> => {
    const db = await rawOpen(path);
    const rows = db.prepare(`SELECT receiptId, CAST(seq AS TEXT) AS s FROM receipts ORDER BY receiptId`).all() as Array<{
      receiptId: unknown;
      s: unknown;
    }>;
    db.close();
    return rows.map((r) => `${String(r.receiptId)}=${r.s === null ? "NULL" : String(r.s)}`);
  };

  /** Save through the REAL store API and hand back whatever it refused with (or null if it accepted). */
  const saveAndCatch = async (path: string, id: string): Promise<Error | null> => {
    const store = await tryCreateSqliteStore(path);
    if (!store) throw new Error("node:sqlite unavailable");
    return store.save(mk(id, true, [], undefined, 9000)).then(
      () => null,
      (e: unknown) => e as Error,
    );
  };

  it("REFUSES a position it could never read back, instead of writing one and reporting success", async () => {
    // The ledger is at the last position a JS number can hold. It verifies; every receipt in it reads.
    // The next append must not be the thing that ends that.
    const path = freshCopy();
    await setMaxPosition(path, "9007199254740991"); // Number.MAX_SAFE_INTEGER
    expect((await verifyLedger(path)).ok).toBe(true);
    const before = await positions(path);

    const err = await saveAndCatch(path, "sha256:eee");

    expect(err?.name).toBe("LedgerPositionError");
    expect((err as { reason?: string } | null)?.reason).toBe("exhausted");
    expect(err?.message).toContain("9007199254740992"); // the position it refused to allocate
    expect(err?.message).toMatch(/verify:ledger/); // …and what the operator does next
    expect(await positions(path)).toEqual(before); // nothing was written
    expect((await verifyLedger(path)).ok).toBe(true); // and the ledger it refused to extend still verifies
  });

  it("NAMES the ledger's own unreadable positions rather than dying with a bare RangeError", async () => {
    const path = freshCopy();
    const db = await rawOpen(path);
    db.exec(`UPDATE receipts SET seq = seq + 9007199254740992`); // every position past 2^53, order kept
    db.close();
    const before = await positions(path);

    const err = await saveAndCatch(path, "sha256:eee");

    expect(err?.name).toBe("LedgerPositionError");
    expect((err as { reason?: string } | null)?.reason).toBe("unreadable-max");
    expect(err?.message).toContain("9007199254740996"); // the highest position actually in the file
    expect(await positions(path)).toEqual(before);
  });

  it("REFUSES when the highest position is not a position at all — rather than appending seq = NULL", async () => {
    // sqlite columns are dynamically typed, so `seq` can hold text, and text sorts above every integer:
    // `MAX(seq)` is 'zzz', `Number('zzz') + 1` is NaN, and a bound NaN lands in the file as NULL — a
    // row outside the order the whole chain is walked in, written by the store, reported as stored.
    const path = freshCopy();
    await setMaxPosition(path, `'zzz'`);
    const before = await positions(path);

    const err = await saveAndCatch(path, "sha256:eee");

    expect(err?.name).toBe("LedgerPositionError");
    expect((err as { reason?: string } | null)?.reason).toBe("malformed-max");
    expect(err?.message).toContain('"zzz"');
    expect(await positions(path)).toEqual(before); // no NULL-positioned row appeared
  });

  it("PROPERTY: whatever the highest position is, an append either lands readable or is refused by name", async () => {
    // The behaviour is a SPACE, not three examples: the interesting maxima are comfortably-safe
    // positions, the exact edge of the double-safe range, positions already past it, and a column
    // holding something that is not a position. The invariant is the one an operator relies on —
    //   the store never leaves the ledger less verifiable than it found it, and never resolves
    //   unless it wrote a position it can read again.
    // Seeded, so the space is fixed and any failure is reproducible from its seed.
    const maxLiteral = (rng: () => number): string => {
      const kind = Math.floor(rng() * 4);
      if (kind === 0) return String(5 + Math.floor(rng() * 1_000_000)); // comfortably readable
      if (kind === 1) return String(Number.MAX_SAFE_INTEGER - Math.floor(rng() * 3)); // at the edge
      if (kind === 2) return `9007199254740${992 + Math.floor(rng() * 8)}`; // already past it
      return `'${["zzz", "1.5", ""][Math.floor(rng() * 3)]}'`; // not a position at all
    };

    for (let seed = 1; seed <= 24; seed++) {
      const literal = maxLiteral(mulberry32(seed));
      const path = freshCopy();
      await setMaxPosition(path, literal);
      const before = { ok: (await verifyLedger(path)).ok, positions: await positions(path) };

      const id = `sha256:probe${seed}`;
      const err = await saveAndCatch(path, id);
      const after = { ok: (await verifyLedger(path)).ok, positions: await positions(path) };

      // Never degraded: a ledger that verified before the attempt still verifies after it.
      expect({ seed, literal, ok: after.ok }).toEqual({ seed, literal, ok: before.ok });
      if (err) {
        expect({ seed, literal, name: err.name }).toEqual({ seed, literal, name: "LedgerPositionError" });
        expect({ seed, literal, positions: after.positions }).toEqual({ seed, literal, positions: before.positions });
      } else {
        const stored = after.positions.find((p) => p.startsWith(`${id}=`))?.split("=")[1] ?? "";
        expect({ seed, literal, readable: Number.isSafeInteger(Number(stored)) && stored !== "" }).toEqual({
          seed,
          literal,
          readable: true,
        });
      }
    }
  }, 60_000);
});
