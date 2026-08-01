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
