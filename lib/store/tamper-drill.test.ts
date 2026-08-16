/**
 * Pacioli — the TAMPER DRILL. "Tamper-evident" was previously proven by hand-written example tests,
 * which prove exactly the tampers their author thought of.
 *
 * This is the invariant instead: for ANY tamper drawn from the generated space, verifyLedger() must
 * FAIL. A scripted adversary mutates a COPY of a real ledger one class at a time from a seeded
 * generator, so every case is reproducible from (seed, class) and a new class extends coverage
 * automatically.
 *
 * The NEGATIVE CONTROL is mandatory and comes first: an untampered ledger must PASS. A drill whose
 * verifier rejects everything proves nothing at all.
 *
 * The documented BOUNDARIES are pinned too (they must still verify): the leaf deliberately does not
 * cover seenCount, and an adversary who re-seals the whole file produces a self-consistent ledger —
 * detecting that needs an off-box anchor, not a better walk. Pinning them keeps docs/VERIFICATION.md
 * honest: if a boundary ever moves, this file goes red and the claim gets re-stated deliberately.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCreateSqliteStore, type StoredReceipt } from "./receipt-store";
import { runTamperDrill, renderDrillReport, TAMPER_CLASSES, type DrillReport } from "./tamper-drill";

const dir = mkdtempSync(join(tmpdir(), "pacioli-drill-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LEDGER = join(dir, "drill-target.db");
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const mk = (i: number, session?: string): StoredReceipt => ({
  receiptId: `sha256:drill${String(i).padStart(4, "0")}`,
  receiptHash: `h${i}`,
  balanced: i % 3 !== 0,
  findingTypes: i % 3 !== 0 ? [] : i % 2 === 0 ? ["OVERSPEND"] : ["SCOPE_CREEP", "UNAUTH_RECURRENCE"],
  agent: i % 2 === 0 ? "booker" : "refunder",
  merchant: i % 2 === 0 ? "United" : "Acme",
  deltaUsd: i % 3 !== 0 ? null : 10 * i,
  createdAt: 1_700_000_000_000 + i * 1000,
  sessionKey: session,
});

let report: DrillReport;
beforeAll(async () => {
  // A realistic target: three scopes (two sessions + the sessionless rows), flagged and clean
  // receipts, written through the store API — the only way a chain can legitimately come to exist.
  const s = await tryCreateSqliteStore(LEDGER);
  if (!s) throw new Error("node:sqlite unavailable — the drill needs a durable store");
  for (let i = 1; i <= 12; i++) {
    await s.save(mk(i, i % 4 === 0 ? undefined : i % 2 === 0 ? "user-alice" : "user-bob"));
  }
  report = await runTamperDrill({ ledger: LEDGER, workdir: join(dir, "cases"), seeds: SEEDS });
}, 120_000);

describe("ledger tamper drill", () => {
  it("NEGATIVE CONTROL — an untampered ledger verifies (a drill that fails everything proves nothing)", () => {
    expect(report.control).toEqual({ ok: true, receipts: 12, faults: [] });
  });

  it("INVARIANT — every in-model tamper is caught, across every seed", () => {
    // The message is the finding: if a class escapes, name it here rather than in a diff of numbers.
    expect(report.escapes.map((e) => `${e.classId} (seed ${e.seed}): ${e.what}`)).toEqual([]);
    expect(report.attempted).toBeGreaterThanOrEqual(100);
    expect(report.ok).toBe(true);
  });

  it("every declared in-model class actually fired at least once (an inapplicable class proves nothing)", () => {
    const idle = report.classes.filter((c) => c.model === "in-model" && c.attempted === 0).map((c) => c.id);
    expect(idle).toEqual([]);
    // …and the registry is the coverage surface, so it must be the thing that grew.
    expect(TAMPER_CLASSES.filter((c) => c.model === "in-model").length).toBeGreaterThanOrEqual(20);
  });

  it("every catch is LOCATED — a fault kind and a non-empty diagnosis, never a bare failure", () => {
    const vague = report.classes.filter((c) => c.model === "in-model" && c.attempted > 0 && c.faultKinds.length === 0);
    expect(vague.map((c) => c.id)).toEqual([]);
    expect(report.unlocated).toEqual([]);
  });

  it("PINS the documented boundaries — these must still verify, and the docs say so", () => {
    const boundaries = report.classes.filter((c) => c.model === "boundary");
    expect(boundaries.map((c) => c.id).sort()).toEqual([
      "boundary-full-reseal-rewrite",
      "boundary-full-reseal-wipe",
      "boundary-prefix-prune",
      "boundary-seen-count",
      "boundary-seq-renumber",
    ]);
    // A boundary case that starts FAILING means the verifier grew a new power (good) — but the claim
    // in docs/VERIFICATION.md then has to be re-stated deliberately, not drift.
    expect(report.pinBreaks).toEqual([]);
    for (const b of boundaries) expect(b.attempted).toBeGreaterThan(0);
  });

  it("publishes EVERY class it ran — a class missing from the report is coverage nobody can audit", () => {
    const md = renderDrillReport(report, "dataset/reference-ledger.db");
    for (const c of TAMPER_CLASSES) expect(md).toContain(`\`${c.id}\``);
    expect(md).toContain("272/272"); // 34 in-model classes × 8 seeds, none inapplicable to this ledger
    expect(md).toMatch(/Negative control.*VERIFIES/);
  });

  it("is reproducible — the same seeds produce the same report", async () => {
    const again = await runTamperDrill({ ledger: LEDGER, workdir: join(dir, "cases-again"), seeds: SEEDS });
    expect(again).toEqual(report);
  }, 120_000);

  it("the CI GATE is the exit code, so the exit code is what gets locked", () => {
    // The drill only protects anything because a hole exits non-zero. Point it at a ledger that is
    // ALREADY tampered with and the negative control fails — at which point nothing the drill measured
    // means anything, and it must refuse to report success rather than print a 100% caught rate over a
    // broken baseline.
    const cli = (...a: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "lib/store/tamper-drill-cli.ts", ...a], {
        encoding: "utf8",
      });

    expect(cli("--help").status).toBe(0);
    expect(cli("--seeds", "not-a-number").status).toBe(2); // bad usage is not the same as a finding

    const clean = cli(LEDGER, "--seeds", "1");
    expect(clean.status).toBe(0); // a sound ledger exits 0 — the gate must not be a gate that always fires
    expect(clean.stdout).toContain("DRILLED");

    const tampered = join(dir, "control-broken.db");
    copyFileSync(LEDGER, tampered);
    const raw = spawnSync(
      process.execPath,
      ["-e", `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("UPDATE receipts SET merchant='Forged' WHERE seq=2");d.close();`, tampered],
      { encoding: "utf8" },
    );
    expect(raw.status).toBe(0);
    const out = cli(tampered, "--seeds", "1");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("NEGATIVE CONTROL");
  }, 120_000);
});
