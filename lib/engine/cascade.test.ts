import { describe, it, expect } from "vitest";
import {
  cascadeMetrics,
  cascadeReconcile,
  classOf,
  CLAIM_CASCADE,
  EQUIV_CASCADE,
  equivCascadeViolations,
  expensiveOnEverything,
  goldOracleJudge,
  offJudge,
  scoreTrace,
  telemetrySlice,
  type JudgeFn,
} from "./cascade";
import { loadSeed, loadIncidents } from "./dataset";
import type { DiffInput, Finding, GroundTruthSample } from "@pacioli-app/engine";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

/** A claim the deterministic tier FLAGS (over budget → OVERSPEND). */
const firing: DiffInput = {
  claim: { agent: "a", task: "book under $300", text: "booked for $5000", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "email", merchant: "United", amountUsd: 5000, date: null, items: [], recurring: false, excerpt: "Total $5000" },
};

/** A clean claim the deterministic tier is SILENT on (within budget, nothing wrong). */
const residual: DiffInput = {
  claim: { agent: "a", task: "book under $300", text: "booked for $278", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "email", merchant: "United", amountUsd: 278, date: null, items: [], recurring: false, excerpt: "Total $278" },
};

const cmFinding = (): Finding[] => [
  { type: "CLAIM_MISMATCH", dimension: "scope", severity: "medium", claimedRef: "x", actualRef: "y", llmAssisted: true, note: "n" },
];
const flagEverythingJudge: JudgeFn = async () => cmFinding();
const throwingJudge: JudgeFn = async () => {
  throw new Error("the judge must not be called when the cheap tier already resolved");
};

const corpus = (): GroundTruthSample[] => [...loadSeed(), ...loadIncidents()];

// ── the cascade primitive ───────────────────────────────────────────────────────────────────────────

describe("cascadeReconcile — trust the cheap tier, escalate only the residual", () => {
  it("does NOT call the judge when the deterministic tier fires (trust-on-resolve)", async () => {
    const res = await cascadeReconcile(firing, throwingJudge); // throwingJudge proves it is never awaited
    expect(res.escalated).toBe(false);
    expect(res.cheapClass).toBe("flagged");
    expect(res.judgeFindings).toEqual([]);
    expect(classOf(res.verdict.findings)).toBe("flagged");
  });

  it("escalates to the judge when the deterministic tier is silent, and merges the residual", async () => {
    const res = await cascadeReconcile(residual, flagEverythingJudge);
    expect(res.escalated).toBe(true);
    expect(res.cheapClass).toBe("balanced");
    expect(res.judgeFindings).toHaveLength(1);
    expect(classOf(res.verdict.findings)).toBe("flagged"); // judge flipped it
  });

  it("trust-all NEVER escalates (the lossy baseline)", async () => {
    const res = await cascadeReconcile(residual, throwingJudge, "trust-all");
    expect(res.escalated).toBe(false);
    expect(classOf(res.verdict.findings)).toBe("balanced"); // judge never consulted → misses the residual
  });
});

// ── EQUIV-CASCADE: the lossless guarantee, falsified not asserted ────────────────────────────────────

describe("EQUIV-CASCADE — cascaded class == expensive-on-everything class", () => {
  it("holds (0 violations) over the whole labeled corpus with the gold-oracle judge", async () => {
    const rows = corpus();
    const v = await equivCascadeViolations(rows.map((r) => r.input), goldOracleJudge(rows), "trust-on-resolve");
    expect(v).toEqual([]);
  });

  it("is JUDGE-AGNOSTIC: holds even for an adversarial flag-everything judge (trust-on-resolve)", async () => {
    const inputs = [firing, residual];
    expect(await equivCascadeViolations(inputs, flagEverythingJudge, "trust-on-resolve")).toEqual([]);
  });

  it("BITES under the lossy trust-all baseline (so the safe-policy 0 is not vacuous)", async () => {
    const rows = corpus();
    const v = await equivCascadeViolations(rows.map((r) => r.input), goldOracleJudge(rows), "trust-all");
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.property === EQUIV_CASCADE)).toBe(true);
  });

  it("expensiveOnEverything == cascade(trust-on-resolve) on the SILENT path (identical, not just same class)", async () => {
    const ref = await expensiveOnEverything(residual, flagEverythingJudge);
    const cas = await cascadeReconcile(residual, flagEverythingJudge);
    expect(cas.verdict.findings).toEqual(ref.findings);
  });
});

// ── telemetry / metrics ──────────────────────────────────────────────────────────────────────────────

describe("cascadeMetrics — alpha / escalation / disagreement / losslessViolations", () => {
  it("alpha + escalationRate == 1, and losslessViolations == 0 under trust-on-resolve", async () => {
    const rows = corpus();
    const m = await cascadeMetrics(rows.map((r) => r.input), goldOracleJudge(rows), { judgeLabel: "gold-oracle" });
    expect(m.alpha + m.escalationRate).toBeCloseTo(1, 10);
    expect(m.losslessViolations).toBe(0);
    expect(m.regime).toEqual({ cheap: "model-free-provable", expensive: "model-based-residual" });
    expect(m.locus).toBe("claim");
  });

  it("alpha equals the fraction the deterministic tier fires (judge-independent)", async () => {
    const inputs = [firing, residual, residual]; // 1 of 3 fires
    const withOff = await cascadeMetrics(inputs, offJudge);
    const withFlagAll = await cascadeMetrics(inputs, flagEverythingJudge);
    expect(withOff.alpha).toBeCloseTo(1 / 3, 10);
    expect(withFlagAll.alpha).toBeCloseTo(1 / 3, 10); // escalation keys on cheap-silent, not on judge output
  });

  it("disagreementRate counts inputs where the cheap tier is silent but the judge flags", async () => {
    const inputs = [firing, residual]; // firing: both flagged (agree); residual: cheap balanced, judge flags (disagree)
    const m = await cascadeMetrics(inputs, flagEverythingJudge);
    expect(m.disagreementRate).toBeCloseTo(0.5, 10);
  });

  it("the lossy trust-all baseline reports losslessViolations > 0 where the judge would have flipped the class", async () => {
    const rows = corpus();
    const m = await cascadeMetrics(rows.map((r) => r.input), goldOracleJudge(rows), { policy: "trust-all" });
    expect(m.losslessViolations).toBeGreaterThan(0);
  });

  it("telemetrySlice emits the consistent suite shape", async () => {
    const m = await cascadeMetrics([firing, residual], offJudge);
    const slice = telemetrySlice(m);
    expect(slice).toEqual({
      repo: "pacioli",
      boundary: CLAIM_CASCADE.id,
      alpha: m.alpha,
      disagreementRate: m.disagreementRate,
      losslessViolations: m.losslessViolations,
    });
  });
});

// ── the gold-oracle keyless judge ────────────────────────────────────────────────────────────────────

describe("goldOracleJudge — keyless perfect expensive tier from the human labels", () => {
  it("flags CLAIM_MISMATCH exactly when the gold label does, and abstains otherwise", async () => {
    const rows = corpus();
    const judge = goldOracleJudge(rows);
    for (const r of rows) {
      const goldCM = (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");
      const out = await judge(r.input);
      expect(out.some((f) => f.type === "CLAIM_MISMATCH")).toBe(goldCM);
    }
  });
});

// ── scoreTrace: the suite MPC objective seam ─────────────────────────────────────────────────────────

describe("scoreTrace — {score, feasible, abstained} objective seam", () => {
  it("abstains on an empty candidate set", async () => {
    expect(await scoreTrace([])).toEqual({ score: 0, feasible: true, abstained: true });
  });

  it("returns score == alpha in [0,1], feasible, not abstained on a real set", async () => {
    const inputs = [firing, residual, residual];
    const t = await scoreTrace(inputs);
    expect(t.abstained).toBe(false);
    expect(t.feasible).toBe(true);
    expect(t.score).toBeGreaterThanOrEqual(0);
    expect(t.score).toBeLessThanOrEqual(1);
    expect(t.score).toBeCloseTo(1 / 3, 10);
  });

  it("score is judge-independent (no model nondeterminism leaks into the objective)", async () => {
    const inputs = [firing, residual, residual];
    const a = await scoreTrace(inputs, { judge: offJudge });
    const b = await scoreTrace(inputs, { judge: flagEverythingJudge });
    expect(a.score).toBe(b.score);
  });
});
