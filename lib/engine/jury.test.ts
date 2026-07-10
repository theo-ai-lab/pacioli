import { describe, it, expect } from "vitest";
import {
  consensusFromVoteMatrix,
  runJury,
  mockJury,
  facetJuror,
  scoreThresholdJuror,
  seedRealJury,
  isHighConsensusMismatch,
  DEFAULT_CONSENSUS_GATE,
} from "./jury";
import { diff } from "@pacioli-app/engine";
import { loadSeed, loadIncidents } from "./dataset";
import type { DiffInput } from "@pacioli-app/engine";

// ── the honesty core: correlation-corrected EFFECTIVE votes, not member count ─────────────────────────────

describe("consensusFromVoteMatrix — effectiveJurors discounts correlated panels", () => {
  it("three IDENTICAL jurors carry ~1 effective vote, not 3 (ρ̄=1)", () => {
    const v = [true, false, true, false, true];
    const c = consensusFromVoteMatrix(["a", "b", "c"], [v, v, v]);
    expect(c.m).toBe(3);
    expect(c.meanPairwiseCorrelation).toBeCloseTo(1, 6);
    expect(c.effectiveJurors).toBeCloseTo(1, 6); // 3 / (1 + 2·1)
  });

  it("anti-correlated jurors get FULL independence credit, clamped to m (never above)", () => {
    const a = [true, false, true, false];
    const b = [false, true, false, true];
    const c = consensusFromVoteMatrix(["a", "b"], [a, b]);
    expect(c.meanPairwiseCorrelation).toBe(0); // ρ raw = −1, clamped to 0 for the deflation
    expect(c.effectiveJurors).toBeCloseTo(2, 6); // 2 / (1 + 1·0) = 2, capped at m
    expect(c.effectiveJurors).toBeLessThanOrEqual(c.m);
  });

  it("a partially-correlated panel lands strictly between 1 and m", () => {
    // four jurors that mostly-but-not-always agree → 1 < eff < 4
    const j0 = [true, true, true, false, false, false, true, false];
    const j1 = [true, true, false, false, false, true, true, false];
    const j2 = [true, false, true, false, true, false, true, false];
    const j3 = [false, true, true, false, false, false, true, true];
    const c = consensusFromVoteMatrix(["j0", "j1", "j2", "j3"], [j0, j1, j2, j3]);
    expect(c.meanPairwiseCorrelation).toBeGreaterThan(0);
    expect(c.meanPairwiseCorrelation).toBeLessThan(1);
    expect(c.effectiveJurors).toBeGreaterThan(1);
    expect(c.effectiveJurors).toBeLessThan(c.m);
  });

  it("a CONSTANT juror counts as fully redundant (no independent vote)", () => {
    const varying = [true, false, true, false];
    const constant = [true, true, true, true];
    const c = consensusFromVoteMatrix(["v", "k"], [varying, constant]);
    expect(c.meanPairwiseCorrelation).toBe(1); // a constant juror is treated as ρ=1 (conservative)
    expect(c.effectiveJurors).toBeCloseTo(1, 6);
  });

  it("aggregates rows by STRICT majority (ties abstain) and reports per-row agreement", () => {
    // 3 jurors; row0 = 2/3 flag (majority), row1 = 1/3 flag (no majority)
    const c = consensusFromVoteMatrix(["a", "b", "c"], [
      [true, false],
      [true, true],
      [false, false],
    ]);
    expect(c.rows[0].flagCount).toBe(2);
    expect(c.rows[0].consensusFlag).toBe(true);
    expect(c.rows[0].agreement).toBeCloseTo(2 / 3, 6);
    expect(c.rows[1].flagCount).toBe(1);
    expect(c.rows[1].consensusFlag).toBe(false);
    expect(c.rows[1].agreement).toBeCloseTo(2 / 3, 6); // 2 of 3 on the "no" side
  });

  it("an even split is NOT a consensus flag (ties resolve to abstain, never guess)", () => {
    const c = consensusFromVoteMatrix(["a", "b"], [[true], [false]]);
    expect(c.rows[0].flagCount).toBe(1);
    expect(c.rows[0].consensusFlag).toBe(false); // 1 of 2 is not a strict majority
  });

  it("rejects ragged vote matrices (every juror must vote on the same rows)", () => {
    expect(() => consensusFromVoteMatrix(["a", "b"], [[true, false], [true]])).toThrow(RangeError);
  });
});

// ── the keyless mock jury (a documented synthetic instrument) ─────────────────────────────────────────────

describe("mockJury — diverse, deterministic, keyless; the correction visibly bites", () => {
  const residual: DiffInput[] = [...loadSeed(), ...loadIncidents()]
    .filter((r) => diff(r.input).findings.length === 0)
    .map((r) => r.input);

  it("is a multi-facet panel whose effectiveJurors is strictly below the member count", async () => {
    const consensus = await runJury(mockJury(), residual);
    expect(consensus.m).toBe(4);
    expect(consensus.meanPairwiseCorrelation).toBeGreaterThan(0); // the facets overlap
    expect(consensus.effectiveJurors).toBeLessThan(consensus.m); // correlation correction bites
    expect(consensus.effectiveJurors).toBeGreaterThan(1);
  });

  it("is deterministic: the same panel over the same inputs gives an identical consensus", async () => {
    const a = await runJury(mockJury(), residual);
    const b = await runJury(mockJury(), residual);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a score-threshold juror flags iff the keyless proxy clears its threshold", async () => {
    const high = scoreThresholdJuror("hi", 0.99);
    const low = scoreThresholdJuror("lo", 0.0);
    const suspicious: DiffInput = {
      claim: { agent: "a", task: "book the cheapest nonstop", text: "booked the cheapest nonstop", authorized: { constraints: ["cheapest", "nonstop"], mayPurchase: true } },
      evidence: { source: "email", merchant: "X", amountUsd: 10, date: "2025-01-01", items: [], recurring: false, excerpt: "we booked a connecting flight instead, unable to find nonstop" },
    };
    expect((await low.judge(suspicious)).length).toBe(1); // threshold 0 always fires
    expect((await high.judge(suspicious)).length).toBe(0); // threshold 0.99 essentially never fires
  });
});

// ── the high-consensus gate ──────────────────────────────────────────────────────────────────────────────

describe("isHighConsensusMismatch — needs agreement AND enough EFFECTIVE votes", () => {
  it("a chorus of clones cannot manufacture high consensus (effectiveJurors below the gate)", () => {
    const v = [true, true, true];
    const clones = consensusFromVoteMatrix(["a", "b", "c"], [v, v, v]); // eff ≈ 1
    // unanimous flag, but only ~1 effective vote → blocked by the default minEffectiveJurors gate
    expect(clones.rows[0].consensusFlag).toBe(true);
    expect(clones.rows[0].agreement).toBe(1);
    expect(isHighConsensusMismatch(clones.rows[0], clones, DEFAULT_CONSENSUS_GATE)).toBe(false);
  });

  it("a diverse, agreeing panel passes the gate", () => {
    // three jurors with enough disagreement elsewhere to keep eff > 1.5, but unanimous on row 0
    const c = consensusFromVoteMatrix(["a", "b", "c"], [
      [true, true, false, false],
      [true, false, true, false],
      [true, false, false, true],
    ]);
    expect(c.effectiveJurors).toBeGreaterThanOrEqual(1.5);
    expect(isHighConsensusMismatch(c.rows[0], c, DEFAULT_CONSENSUS_GATE)).toBe(true);
  });
});

// ── gated real jury seeding (honest degeneracy with no backends) ─────────────────────────────────────────

describe("seedRealJury — gates honestly; never fabricates or pads a panel", () => {
  it("with no key and no Ollama, returns an empty panel that is explicitly NOT a jury", async () => {
    const seed = await seedRealJury();
    // CI has neither an ANTHROPIC_API_KEY nor a local Ollama, so zero distinct backends are available.
    expect(seed.jurors.length).toBe(seed.available.length);
    if (seed.available.length < 2) {
      expect(seed.isJury).toBe(false);
      expect(seed.note).toMatch(/NOT a jury/);
    }
  });
});

describe("facetJuror — returns a single badged CLAIM_MISMATCH finding when its predicate holds", () => {
  it("badges its finding llmAssisted and cites both sides", async () => {
    const j = facetJuror("always", "test", () => true);
    const input: DiffInput = {
      claim: { agent: "a", task: "t", text: "claim text", authorized: {} },
      evidence: { source: "email", merchant: "M", amountUsd: null, date: null, items: [], recurring: false, excerpt: "evi" },
    };
    const findings = await j.judge(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("CLAIM_MISMATCH");
    expect(findings[0].llmAssisted).toBe(true);
    expect(findings[0].claimedRef).toBe("claim text");
    expect(findings[0].actualRef).toBe("evi");
  });
});
