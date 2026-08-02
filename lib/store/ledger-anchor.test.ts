/**
 * Pacioli — the off-box anchor. Closing the boundary the drill declares but cannot catch.
 *
 * `verifyLedger` walks the file and reports whether it is internally self-consistent. An adversary
 * with write access to that file can edit a receipt and RE-DERIVE every leaf, link, head and root,
 * or delete everything and re-seal the result as an empty ledger. Both produce a perfectly
 * self-consistent record, so the walk returns VERIFIED and the CLI prints it. The drill models both
 * (`boundary-full-reseal-rewrite`, `boundary-full-reseal-wipe`) and classifies them as BOUNDARIES —
 * its own description says why: "self-consistent, and only an off-box anchor can tell."
 *
 * That is the gap this file closes. An anchor is a commitment to the whole-store head, root and
 * count, taken at a moment the record was trusted and kept somewhere the attacker does not control.
 * Verification against an anchor answers the question the walk cannot: not "is this file
 * consistent?" but "is this the same ledger I committed to?"
 *
 * The security property lives in WHERE the anchor is kept, not in this code. A copy sitting next to
 * the database is taken by the same attacker who took the database. So the report also has to say,
 * structurally rather than in prose, whether it was checked against one at all — otherwise a caller
 * cannot tell an anchored VERIFIED from an unanchored one, which is exactly the confusion the single
 * word "VERIFIED" creates today.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tryCreateSqliteStore, type StoredReceipt } from "./receipt-store";
import { verifyLedger } from "./verify-ledger";
import { anchorFromLedger, type LedgerAnchor } from "./ledger-anchor";
import { GENESIS, WHOLE_STORE, scopeRoot } from "./ledger-chain";

const dir = mkdtempSync(join(tmpdir(), "pacioli-anchor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const mk = (i: number): StoredReceipt => ({
  receiptId: `sha256:anchor${String(i).padStart(4, "0")}`,
  receiptHash: `h${i}`,
  balanced: i % 2 === 0,
  findingTypes: i % 2 === 0 ? [] : ["OVERSPEND"],
  agent: "booker",
  merchant: "United",
  deltaUsd: i % 2 === 0 ? null : 10 * i,
  createdAt: 1_700_000_000_000 + i * 1000,
});

let ledger: string;
beforeEach(async () => {
  ledger = join(dir, `ledger-${n++}.db`);
  const s = await tryCreateSqliteStore(ledger);
  if (!s) throw new Error("node:sqlite unavailable — the anchor tests need a durable store");
  for (let i = 1; i <= 5; i++) await s.save(mk(i));
});

/** The attacker: `boundary-full-reseal-wipe`, verbatim in effect — wipe, then re-seal as empty. */
async function wipeAndReseal(path: string): Promise<void> {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync } = require_("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...a: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  db.exec(`DELETE FROM receipts`);
  db.prepare(`DELETE FROM chain_state WHERE scope <> ?`).run(WHOLE_STORE);
  db.prepare(
    `UPDATE chain_state SET count = 0, head = ?, root = ?, rootCount = 0, prunedSeq = 0, prunedHash = '', unchained = 0
     WHERE scope = ?`,
  ).run(GENESIS, await scopeRoot([]), WHOLE_STORE);
  db.close();
}

describe("the walk alone cannot tell a re-sealed ledger from the real one", () => {
  it("a wiped-and-re-sealed ledger still passes the walk — this is the boundary, pinned", async () => {
    await wipeAndReseal(ledger);
    const report = await verifyLedger(ledger);
    expect({ ok: report.ok, faults: report.faults }).toEqual({ ok: true, faults: [] });
  });
});

describe("an anchor answers the question the walk cannot", () => {
  it("records the whole-store commitment", async () => {
    const anchor = await anchorFromLedger(ledger);
    expect(anchor.scope).toBe(WHOLE_STORE);
    expect(anchor.count).toBe(5);
    // Bare lowercase hex, no algorithm prefix — checked against a real ledger, not assumed.
    expect(anchor.head).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CATCHES the re-seal the walk misses", async () => {
    const anchor = await anchorFromLedger(ledger);
    await wipeAndReseal(ledger);

    const report = await verifyLedger(ledger, { anchor });
    expect(report.ok).toBe(false);
    const fault = report.faults.find((f) => f.kind === "anchor-mismatch");
    expect(fault).toBeDefined();
    // The operator has to learn WHAT diverged, not merely that something did.
    expect(fault!.detail).toContain("5");
    expect(fault!.expected).toBe(anchor.root);
  });

  it("passes an untampered ledger against its own anchor", async () => {
    const anchor = await anchorFromLedger(ledger);
    const report = await verifyLedger(ledger, { anchor });
    expect({ ok: report.ok, faults: report.faults }).toEqual({ ok: true, faults: [] });
  });

  it("catches a ledger that GREW past its anchor without the anchor being refreshed", async () => {
    const anchor = await anchorFromLedger(ledger);
    const s = await tryCreateSqliteStore(ledger);
    await s!.save(mk(99));

    const report = await verifyLedger(ledger, { anchor });
    // Honest appends are legitimate, but they are not what the anchor committed to. Reporting the
    // divergence and letting an operator re-anchor beats silently accepting any future the file
    // happens to contain — that acceptance is precisely what a re-seal exploits.
    expect(report.ok).toBe(false);
    expect(report.faults.map((f) => f.kind)).toContain("anchor-mismatch");
  });
});

describe("the report says whether it was anchored at all", () => {
  it("marks an unanchored verification, so a caller cannot mistake it for an anchored one", async () => {
    const report = await verifyLedger(ledger);
    expect(report.anchored).toBe(false);
  });

  it("marks an anchored verification", async () => {
    const anchor: LedgerAnchor = await anchorFromLedger(ledger);
    const report = await verifyLedger(ledger, { anchor });
    expect(report.anchored).toBe(true);
  });
});
