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
import { GENESIS, WHOLE_STORE, scopeRoot, leafHash, entryHashFor } from "./ledger-chain";

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
    expect(fault!.expected).toContain(anchor.root);
    expect(fault!.expected).toContain(`count=${anchor.count}`);
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

// ── the variant that actually pins head and root ──────────────────────────────
//
// Every mismatch test above differs in COUNT, so the count comparison alone catches
// all of them — deleting the root and head comparisons leaves this file green. An
// adversarial review proved exactly that by deleting both lines and watching 54/54
// still pass. The commit that added them claimed to be mutation-verified; the
// mutation removed the whole `if (diffs.length > 0)` block, which the count
// comparison covered, so the two lines the feature exists for were never pinned.
//
// `boundary-full-reseal-rewrite` is the variant that preserves the receipt count and
// moves only the hashes. It is named in this file's own header as a boundary being
// closed, and until now it was never implemented here.

/** The attacker: edit a receipt, then re-derive every leaf, link, head and root. */
async function editAndReseal(path: string): Promise<void> {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync } = require_("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  const rows = db.prepare(`SELECT * FROM receipts ORDER BY seq ASC`).all() as Record<string, any>[];
  // Flip one receipt's verdict — the tamper a forger actually wants.
  // rows[0] is mk(1): unbalanced, one finding, a non-null delta. Editing a row that
  // already had the target values would be a no-op re-seal and prove nothing.
  rows[0].balanced = 1;
  rows[0].findingTypes = "";
  rows[0].deltaUsd = null;
  db.prepare(`UPDATE receipts SET balanced = 1, findingTypes = '', deltaUsd = NULL WHERE receiptId = ?`).run(
    rows[0].receiptId,
  );

  let prev = GENESIS;
  const leaves: string[] = [];
  for (const r of rows) {
    const leaf = await leafHash({
      receiptId: r.receiptId,
      receiptHash: r.receiptHash,
      balanced: r.balanced === 1,
      findingTypes: r.findingTypes ? String(r.findingTypes).split(",") : [],
      agent: r.agent,
      merchant: r.merchant,
      deltaUsd: r.deltaUsd,
      createdAt: r.createdAt,
      sessionKey: r.sessionKey ?? undefined,
    });
    const entry = await entryHashFor(prev, leaf);
    db.prepare(`UPDATE receipts SET leafHash = ?, prevHash = ?, entryHash = ? WHERE receiptId = ?`).run(
      leaf,
      prev,
      entry,
      r.receiptId,
    );
    leaves.push(leaf);
    prev = entry;
  }
  db.prepare(`UPDATE chain_state SET count = ?, head = ?, root = ?, rootCount = ? WHERE scope = ?`).run(
    leaves.length,
    prev,
    await scopeRoot(leaves),
    leaves.length,
    WHOLE_STORE,
  );
  db.close();
}

describe("the re-seal that keeps the count", () => {
  it("passes the unanchored walk — the boundary, with the count unchanged", async () => {
    await editAndReseal(ledger);
    const report = await verifyLedger(ledger);
    expect({ ok: report.ok, receipts: report.receipts }).toEqual({ ok: true, receipts: 5 });
  });

  it("is CAUGHT by the anchor, and the count comparison is not what catches it", async () => {
    const anchor = await anchorFromLedger(ledger);
    await editAndReseal(ledger);

    const report = await verifyLedger(ledger, { anchor });
    expect(report.ok).toBe(false);
    const fault = report.faults.find((f) => f.kind === "anchor-mismatch");
    expect(fault).toBeDefined();
    // The count is IDENTICAL, so only root/head can have produced this fault. Delete
    // either comparison and this test goes red — which the wipe tests never did.
    expect(fault!.detail).toMatch(/root .* is not the anchored/);
    expect(fault!.detail).toMatch(/head .* is not the anchored/);
    // No count divergence is reported, because there is none. That is the whole
    // point: only the root and head comparisons can have produced this fault, so
    // deleting either one turns this test red — which no wipe-based test does.
    expect(fault!.detail).not.toMatch(/receipt\(s\) present/);
  });

  it("reports what actually diverged in the structured fields, not always the root", async () => {
    const anchor = await anchorFromLedger(ledger);
    await editAndReseal(ledger);
    const report = await verifyLedger(ledger, { anchor });
    const fault = report.faults.find((f) => f.kind === "anchor-mismatch")!;
    // expected/actual used to be hardcoded to the root, so a machine reader could see
    // expected === actual while head and count had both moved.
    expect(fault.expected).not.toBe(fault.actual);
    expect(fault.expected).toContain("count=5");
  });
});

describe("anchored is never true when nothing was compared", () => {
  it("a null anchor from a JS caller does not set anchored", async () => {
    // The TS type forbids this; the field exists for consumers that are not in TS.
    const report = await verifyLedger(ledger, { anchor: null as unknown as undefined });
    expect(report.anchored).toBe(false);
  });
});

// ── an append and a re-seal must not read the same ────────────────────────────
//
// Both diverge from the anchor. Reporting them identically trains the operator to
// answer every mismatch with "that was my append, re-anchor" — which, against a
// re-seal, is the one action that commits to the attacker's history. A live store
// appends constantly, so the training is continuous and the alarm is worthless.

describe("a mismatch says whether the anchored history survived", () => {
  it("an honest append is reported as EXTENDING the anchored ledger", async () => {
    const anchor = await anchorFromLedger(ledger);
    const s = await tryCreateSqliteStore(ledger);
    await s!.save(mk(42));

    const fault = (await verifyLedger(ledger, { anchor })).faults.find(
      (f) => f.kind === "anchor-mismatch",
    );
    expect(fault!.detail).toContain("EXTENDS the anchored ledger");
    expect(fault!.detail).not.toContain("different history");
  });

  it("a re-seal is reported as a DIFFERENT history, not an extension", async () => {
    const anchor = await anchorFromLedger(ledger);
    await editAndReseal(ledger);

    const fault = (await verifyLedger(ledger, { anchor })).faults.find(
      (f) => f.kind === "anchor-mismatch",
    );
    expect(fault!.detail).toContain("NOT intact");
    expect(fault!.detail).not.toContain("EXTENDS");
  });

  it("a wipe is a different history too — there are no anchored leaves left", async () => {
    const anchor = await anchorFromLedger(ledger);
    await wipeAndReseal(ledger);

    const fault = (await verifyLedger(ledger, { anchor })).faults.find(
      (f) => f.kind === "anchor-mismatch",
    );
    expect(fault!.detail).toContain("NOT intact");
  });
});
