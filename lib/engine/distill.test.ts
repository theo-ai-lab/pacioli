import { describe, it, expect } from "vitest";
import {
  ATOM_LIBRARY,
  applyPromotedRules,
  distillRules,
  type CandidateAtom,
  type DistillConfig,
} from "./distill";
import { consensusFromVoteMatrix, mockJury, runJury } from "./jury";
import { diff } from "@pacioli-app/engine";
import { loadSeed, loadIncidents } from "./dataset";
import type { DiffInput, GroundTruthSample } from "@pacioli-app/engine";

const goldCM = (r: GroundTruthSample): boolean => (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");

// ── KEYLESS MOCK-JURY FIXTURE: the whole pipeline runs with zero model spend ──────────────────────────────

describe("distillRules over the real residual with the keyless mock jury (zero model spend)", () => {
  const corpus = [...loadSeed(), ...loadIncidents()];
  const residual = corpus.filter((r) => diff(r.input).findings.length === 0);

  it("promotes the structurally-sound rule and REJECTS the one the jury was fooled into proposing", async () => {
    const consensus = await runJury(mockJury(), residual.map((r) => r.input));
    const result = distillRules(residual, consensus, corpus.length); // default seed 7

    const byAtom = Object.fromEntries(result.candidates.map((c) => [c.atom, c]));

    // evidence-divergence-language: every divergence row in the corpus is a true CLAIM_MISMATCH, so it is
    // proposed by the jury AND survives the gold holdout gate → PROMOTED.
    expect(byAtom["evidence-divergence-language"].promoted).toBe(true);
    expect(byAtom["evidence-divergence-language"].holdout.passed).toBe(true);

    // unverifiable-superlative: the jury (and the keyless proxy) is FOOLED by a clean superlative claim
    // whose date heuristic misfires; the GOLD holdout gate catches it out of sample → REJECTED.
    expect(byAtom["unverifiable-superlative"].promoted).toBe(false);
    expect(byAtom["unverifiable-superlative"].derivation.passed).toBe(true); // it WAS proposed…
    expect(byAtom["unverifiable-superlative"].holdout.passed).toBe(false); // …but gold rejected it OOS

    // claim-evidence-date-conflict: never reaches a high-consensus agreement to mine → not proposed.
    expect(byAtom["claim-evidence-date-conflict"].promoted).toBe(false);

    expect(result.promoted.map((p) => p.atom)).toEqual(["evidence-divergence-language"]);
  });

  it("records correlation-corrected jury provenance on every promoted rule (effective < member count)", async () => {
    const consensus = await runJury(mockJury(), residual.map((r) => r.input));
    const result = distillRules(residual, consensus, corpus.length);
    const rule = result.promoted[0];
    expect(rule.provenance.jurors.length).toBe(4);
    expect(rule.provenance.effectiveJurors).toBeLessThan(4); // NOT the member count
    expect(rule.provenance.effectiveJurors).toBeGreaterThan(1);
    expect(rule.provenance.holdoutPrecision).toBeGreaterThanOrEqual(1); // exact on the held-out slice
    expect(rule.provenance.meanPairwiseCorrelation).toBeGreaterThan(0);
  });

  it("reports an HONEST replaceable fraction: > 0, and the promoted rule's reach is real", async () => {
    const consensus = await runJury(mockJury(), residual.map((r) => r.input));
    const result = distillRules(residual, consensus, corpus.length);
    const r = result.replaceable;

    expect(r.fullResolved).toBeGreaterThan(0);
    expect(r.replaceableFractionFull).toBeCloseTo(r.fullResolved / result.n, 10);
    expect(r.replaceableFractionFull).toBeGreaterThan(0);
    expect(r.replaceableFractionFull).toBeLessThan(1); // it does NOT replace the whole residual — honest

    // coverage moves the right way and the judge-call rate falls by exactly the operational fraction
    expect(result.coverage.deterministicCoverageAfter).toBeGreaterThan(result.coverage.deterministicCoverageBefore);
    expect(result.coverage.residualJudgeRateAfter).toBeLessThan(result.coverage.residualJudgeRateBefore);
    expect(result.coverage.residualJudgeRateBefore - result.coverage.residualJudgeRateAfter).toBeCloseTo(
      r.fullResolved / corpus.length,
      10,
    );
  });

  it("every promoted divergence row is a TRUE CLAIM_MISMATCH (the promotion is not silently wrong)", async () => {
    const consensus = await runJury(mockJury(), residual.map((r) => r.input));
    const result = distillRules(residual, consensus, corpus.length);
    const resolved = residual.filter((r) => applyPromotedRules(r.input, result.promoted).length > 0);
    expect(resolved.length).toBeGreaterThan(0);
    for (const r of resolved) expect(goldCM(r)).toBe(true); // operational precision is 100% on this corpus
  });

  it("applyPromotedRules emits a DETERMINISTIC (not llm-assisted) finding that cites the rule provenance", async () => {
    const consensus = await runJury(mockJury(), residual.map((r) => r.input));
    const result = distillRules(residual, consensus, corpus.length);
    const divergent: DiffInput = {
      claim: { agent: "a", task: "book it", text: "booked your flight", authorized: { mayPurchase: true } },
      evidence: { source: "email", merchant: "X", amountUsd: 10, date: "2025-01-01", items: [], recurring: false, excerpt: "we booked a connecting flight instead" },
    };
    const clean: DiffInput = {
      claim: { agent: "a", task: "book it", text: "booked your flight", authorized: { mayPurchase: true } },
      evidence: { source: "email", merchant: "X", amountUsd: 10, date: "2025-01-01", items: ["flight"], recurring: false, excerpt: "your flight is confirmed" },
    };
    const findings = applyPromotedRules(divergent, result.promoted);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("CLAIM_MISMATCH");
    expect(findings[0].llmAssisted).toBe(false); // it is a RULE now, not a model verdict
    expect(findings[0].note).toContain("DISTILLED:");
    expect(applyPromotedRules(clean, result.promoted)).toHaveLength(0);
  });
});

// ── MACHINERY: the holdout gate genuinely gates (synthetic, corpus-independent) ───────────────────────────

describe("the holdout gate REJECTS a jury-agreed candidate that gold disproves out of sample", () => {
  // Build a synthetic residual: a marker the jury is fooled on (fires on gold-OK rows) vs a sound marker.
  const mark = (id: string, marker: "A" | "B", gold: boolean): GroundTruthSample => ({
    id,
    input: {
      claim: { agent: "x", task: `marker-${marker}`, text: `marker-${marker}`, authorized: {} },
      evidence: { source: "email", merchant: "m", amountUsd: null, date: null, items: [], recurring: false, excerpt: `marker-${marker}` },
    },
    target: { balanced: !gold, findings: gold ? [{ type: "CLAIM_MISMATCH", dimension: "scope", severity: "medium" }] : [] },
    meta: { provenance: "synthetic-seed" },
  });

  // 10 rows carry marker A but are GOLD-OK (the jury is fooled); 10 carry marker B and are GOLD-CM (sound).
  const residual: GroundTruthSample[] = [
    ...Array.from({ length: 10 }, (_, i) => mark(`A${i}`, "A", false)),
    ...Array.from({ length: 10 }, (_, i) => mark(`B${i}`, "B", true)),
  ];
  const atomA: CandidateAtom = { id: "marker-A", explanation: "fires on marker A", fires: (i) => i.claim.text === "marker-A" };
  const atomB: CandidateAtom = { id: "marker-B", explanation: "fires on marker B", fires: (i) => i.claim.text === "marker-B" };

  // A jury that is FOOLED: high-consensus CLAIM_MISMATCH on ALL 20 rows (including the gold-OK marker-A rows).
  const fooledConsensus = consensusFromVoteMatrix(
    ["j0", "j1", "j2"],
    Array.from({ length: 3 }, () => residual.map(() => true)),
  );

  const cfg: Partial<DistillConfig> = {
    atoms: [atomA, atomB],
    consensusGate: { minAgreement: 0.5, minEffectiveJurors: 1 }, // isolate the holdout gate from the consensus gate
    minDerivationSupport: 1,
    derivationPrecisionFloor: 0.5,
    holdoutPrecisionFloor: 1.0,
    splitFraction: 0.5,
    splitSeed: 7,
  };

  it("promotes the sound rule, rejects the fooled one, and the jury proposed BOTH", () => {
    const result = distillRules(residual, fooledConsensus, residual.length, cfg);
    const byAtom = Object.fromEntries(result.candidates.map((c) => [c.atom, c]));

    // both were proposed (the fooled jury agreed on both marker families)
    expect(byAtom["marker-A"].derivation.passed).toBe(true);
    expect(byAtom["marker-B"].derivation.passed).toBe(true);

    // gold disposes: marker-A is REJECTED out of sample (0% gold precision on held-out marker-A rows)
    expect(byAtom["marker-A"].holdout.passed).toBe(false);
    expect(byAtom["marker-A"].holdout.reason).toMatch(/gold precision/);
    // marker-B survives (100% gold precision out of sample)
    expect(byAtom["marker-B"].holdout.passed).toBe(true);

    expect(result.promoted.map((p) => p.atom)).toEqual(["marker-B"]);
  });

  it("the empty corpus and an all-clean residual are well-defined (no promotion, no NaN)", () => {
    const empty = distillRules([], consensusFromVoteMatrix([], []), 0, cfg);
    expect(empty.promoted).toHaveLength(0);
    expect(empty.replaceable.replaceableFractionFull).toBe(0);
    expect(empty.coverage.deterministicCoverageBefore).toBe(0);
  });

  it("throws if the jury consensus does not align 1:1 with the residual", () => {
    expect(() => distillRules(residual, consensusFromVoteMatrix(["j"], [[true]]), residual.length, cfg)).toThrow(RangeError);
  });
});

// ── the candidate-atom library is transparent and pure ────────────────────────────────────────────────────

describe("ATOM_LIBRARY — transparent, deterministic, structurally-explainable predicates", () => {
  it("every atom carries an id + explanation and is a pure boolean predicate", () => {
    const input: DiffInput = {
      claim: { agent: "a", task: "t", text: "t", authorized: {} },
      evidence: { source: "email", merchant: "m", amountUsd: null, date: null, items: [], recurring: false, excerpt: "e" },
    };
    for (const atom of ATOM_LIBRARY) {
      expect(atom.id.length).toBeGreaterThan(0);
      expect(atom.explanation.length).toBeGreaterThan(0);
      expect(atom.fires(input)).toBe(atom.fires(input)); // deterministic
    }
  });
});
