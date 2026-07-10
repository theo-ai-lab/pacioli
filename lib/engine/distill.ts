/**
 * Pacioli — DISTILL THE JUDGE INTO THE DETERMINISTIC FLOOR (jury → holdout-gated → promoted rule).
 *
 * The expensive tier (the LLM judge / jury) touches the whole CLAIM_MISMATCH residual. Some of that
 * residual is, on inspection, structurally OBVIOUS — the merchant evidence literally says "we booked a
 * connecting flight instead". When a high-consensus jury agrees on such rows, that agreement can be
 * DISTILLED into a cheap, always-on DETERMINISTIC rule, shrinking the residual the judge is called on.
 *
 * The discipline that makes this honest rather than overfitting:
 *
 *   1. PROPOSE from the jury, not from gold. Candidate rules are mined ONLY from the jury's HIGH-CONSENSUS
 *      agreements (jury.ts, correlation-corrected effective votes) on a DERIVATION slice. The atom must
 *      structurally explain those agreements — it is a transparent, keyless predicate, never a black box.
 *   2. DISPOSE on gold, OUT OF SAMPLE. Every candidate is HOLDOUT-GATED: it must predict the GROUND-TRUTH
 *      label with precision ≥ the floor on a HELD-OUT slice it was NOT derived from, and fire on ≥1 holdout
 *      row. The jury can be FOOLED (a clean row that merely sounds suspicious); the gold holdout gate is the
 *      stronger check that catches it and REJECTS the candidate. Survivors only are promoted.
 *   3. RECEIPT the promotion. Each promoted rule is Merkle-committed with its full jury-consensus provenance
 *      (distill-receipt.ts), so a distilled rule can never be back-dated or its evidence quietly edited.
 *
 * REPLACEABLE FRACTION, reported honestly: the fraction of the residual the promoted rules now resolve
 * deterministically — given BOTH as the out-of-sample holdout estimate (the defensible generalization
 * number) AND as the operational full-corpus count (what the shipped ruleset actually catches). The judge
 * call-rate falls by exactly that fraction; we never report the in-sample number as the headline.
 *
 * ADDITIVE BY DESIGN: promotion does NOT mutate the canonical `diff()` (whose eval numbers are published and
 * frozen). The promoted ruleset is a governed, receipted EXTENSION you run alongside the engine
 * (`applyPromotedRules`) — real, deterministic, and always-on, but never a silent edit to the measured core.
 */

import { mismatchScore } from "./conformal";
import { mulberry32 } from "./fuzz";
import {
  DEFAULT_CONSENSUS_GATE,
  isHighConsensusMismatch,
  type ConsensusGate,
  type JuryConsensus,
} from "./jury";
import type { DiffInput, Finding, GroundTruthSample } from "@pacioli-app/engine";

// ── the candidate-atom library: transparent, keyless, STRUCTURALLY-EXPLAINABLE boolean predicates ─────────

/** A candidate deterministic atom: a pure boolean predicate over the input plus the human-legible structural
 *  reason it would justify a CLAIM_MISMATCH. Distillation may only ever propose an atom from this library —
 *  it cannot invent an opaque predicate. */
export interface CandidateAtom {
  id: string;
  /** The structural argument a promoted rule would cite — why this predicate implies a mismatch. */
  explanation: string;
  fires: (input: DiffInput) => boolean;
}

/** The atoms reuse the conformal proxy's already-audited components, thresholded to clean booleans, so the
 *  rule layer and the conformal layer cannot drift in how they read a claim. */
export const ATOM_LIBRARY: CandidateAtom[] = [
  {
    id: "evidence-divergence-language",
    explanation:
      "the merchant evidence reports a deviation/substitution (e.g. 'instead', 'unable', 'different', " +
      "'declined', 'cancelled') — the agent's claim of a clean completion is contradicted on its face.",
    fires: (input) => mismatchScore(input).components.divergence >= 1,
  },
  {
    id: "unverifiable-superlative",
    explanation:
      "the claim asserts an unverifiable superlative ('cheapest', 'nonstop', 'only') the evidence does not " +
      "confirm — a qualifier a deterministic rule cannot establish from a single confirmation.",
    fires: (input) => mismatchScore(input).components.qualifier >= 1,
  },
  {
    id: "claim-evidence-date-conflict",
    explanation: "a date asserted in the claim has no match in the evidence — the recorded date disagrees.",
    fires: (input) => mismatchScore(input).components.dateConflict >= 1,
  },
];

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────

export interface DistillConfig {
  /** PROPOSE floor: an atom must explain the jury's high-consensus agreements on the derivation slice with
   *  at least this precision to be a candidate (loose — "this feature coincides with where the jury agrees"). */
  derivationPrecisionFloor: number;
  /** DISPOSE floor: a promoted rule must hit this GOLD precision on its holdout accepted-region (default
   *  1.0 = exact out of sample — the strict generalization gate that catches a jury that was fooled). */
  holdoutPrecisionFloor: number;
  /** Minimum number of high-consensus agreements an atom must explain on the derivation slice. */
  minDerivationSupport: number;
  /** Derivation fraction of the residual; the remainder is the held-out gate slice. */
  splitFraction: number;
  /** Seed for the deterministic derivation/holdout split (so promotion is reproducible). */
  splitSeed: number;
  consensusGate: ConsensusGate;
  atoms: CandidateAtom[];
}

export const DEFAULT_DISTILL_CONFIG: DistillConfig = {
  derivationPrecisionFloor: 0.6,
  holdoutPrecisionFloor: 1.0,
  minDerivationSupport: 2,
  splitFraction: 0.5,
  splitSeed: 7,
  consensusGate: DEFAULT_CONSENSUS_GATE,
  atoms: ATOM_LIBRARY,
};

// ── result shapes ─────────────────────────────────────────────────────────────────────────────────────────

export interface CandidateEval {
  atom: string;
  explanation: string;
  /** PROPOSE: against the jury's high-consensus agreements on the derivation slice. */
  derivation: { firesOn: number; agreedMismatch: number; precision: number | null; support: number; passed: boolean };
  /** DISPOSE: against GROUND TRUTH on the held-out slice the atom was NOT derived from. */
  holdout: { firesOn: number; goldMismatch: number; precision: number | null; passed: boolean; reason: string };
  promoted: boolean;
}

/** Serializable jury-consensus provenance recorded on a promoted rule (and Merkle-committed). */
export interface PromotionProvenance {
  jurors: string[];
  effectiveJurors: number;
  meanPairwiseCorrelation: number;
  consensusGate: ConsensusGate;
  derivationPrecision: number;
  derivationSupport: number;
  holdoutPrecision: number;
  holdoutSupport: number;
  splitSeed: number;
  splitFraction: number;
}

export interface PromotedRule {
  ruleId: string;
  type: "CLAIM_MISMATCH";
  atom: string;
  explanation: string;
  provenance: PromotionProvenance;
}

export interface DistillResult {
  /** Residual size the distillation ran over (rows the deterministic tier abstains on). */
  n: number;
  derivationN: number;
  holdoutN: number;
  effectiveJurors: number;
  meanPairwiseCorrelation: number;
  candidates: CandidateEval[];
  promoted: PromotedRule[];
  /** Honest replaceable fraction: holdout-measured (generalization estimate) + full-corpus (operational). */
  replaceable: {
    /** Of the HELD-OUT residual rows, the fraction the promoted rules resolve deterministically. */
    holdoutResolved: number;
    holdoutN: number;
    replaceableFractionHoldout: number;
    /** Of the FULL residual, the count/fraction the promoted rules resolve (the shipped ruleset's reach). */
    fullResolved: number;
    replaceableFractionFull: number;
  };
  /** Deterministic coverage and residual judge-call rate, before vs after promotion (full corpus). */
  coverage: {
    corpusN: number;
    residualBefore: number;
    deterministicCoverageBefore: number;
    deterministicCoverageAfter: number;
    residualJudgeRateBefore: number;
    residualJudgeRateAfter: number;
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────

const goldIsClaimMismatch = (r: GroundTruthSample): boolean =>
  (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");

/** A seeded index partition of the residual into derivation / holdout (Fisher–Yates with mulberry32). */
function splitIndices(n: number, fraction: number, seed: number): { derivation: number[]; holdout: number[] } {
  const rng = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const cut = Math.floor(n * fraction);
  return { derivation: idx.slice(0, cut), holdout: idx.slice(cut) };
}

// ── the distillation pipeline ─────────────────────────────────────────────────────────────────────────────

/**
 * Distill high-consensus jury agreements over the residual into holdout-gated, promotable deterministic
 * rules. `residual` are the rows the deterministic tier abstains on; `consensus` is the jury's verdict over
 * those SAME rows IN ORDER (consensus.rows[i] ↔ residual[i]); `corpusN` is the full labeled corpus size (for
 * coverage). Pure given its inputs.
 */
export function distillRules(
  residual: readonly GroundTruthSample[],
  consensus: JuryConsensus,
  corpusN: number,
  config: Partial<DistillConfig> = {},
): DistillResult {
  const cfg: DistillConfig = { ...DEFAULT_DISTILL_CONFIG, ...config };
  const n = residual.length;
  if (consensus.rows.length !== n) {
    throw new RangeError(`jury consensus (${consensus.rows.length} rows) must align 1:1 with the residual (${n} rows)`);
  }

  const { derivation, holdout } = splitIndices(n, cfg.splitFraction, cfg.splitSeed);
  const highConsensus = consensus.rows.map((row) => isHighConsensusMismatch(row, consensus, cfg.consensusGate));

  const candidates: CandidateEval[] = [];
  const promoted: PromotedRule[] = [];

  for (const atom of cfg.atoms) {
    const fires = residual.map((r) => atom.fires(r.input));

    // PROPOSE — does the atom explain the jury's high-consensus agreements on the derivation slice?
    const dFires = derivation.filter((i) => fires[i]);
    const dAgreed = dFires.filter((i) => highConsensus[i]).length;
    const dPrecision = dFires.length === 0 ? null : dAgreed / dFires.length;
    const derivationPassed = dPrecision !== null && dPrecision >= cfg.derivationPrecisionFloor && dAgreed >= cfg.minDerivationSupport;

    // DISPOSE — does it predict GROUND TRUTH out of sample on the held-out slice?
    const hFires = holdout.filter((i) => fires[i]);
    const hGold = hFires.filter((i) => goldIsClaimMismatch(residual[i])).length;
    const hPrecision = hFires.length === 0 ? null : hGold / hFires.length;
    let holdoutPassed = false;
    let reason: string;
    if (!derivationPassed) {
      reason = "not proposed (failed the derivation/high-consensus gate)";
    } else if (hFires.length === 0) {
      reason = "rejected: the atom fires on no held-out row — its generalization is unconfirmed out of sample";
    } else if (hPrecision !== null && hPrecision >= cfg.holdoutPrecisionFloor) {
      holdoutPassed = true;
      reason = `passed: gold precision ${(hPrecision * 100).toFixed(0)}% on ${hFires.length} held-out row(s)`;
    } else {
      reason = `rejected: gold precision ${((hPrecision ?? 0) * 100).toFixed(0)}% < floor ${(cfg.holdoutPrecisionFloor * 100).toFixed(0)}% out of sample`;
    }

    const promotedThis = derivationPassed && holdoutPassed;
    candidates.push({
      atom: atom.id,
      explanation: atom.explanation,
      derivation: { firesOn: dFires.length, agreedMismatch: dAgreed, precision: dPrecision, support: dAgreed, passed: derivationPassed },
      holdout: { firesOn: hFires.length, goldMismatch: hGold, precision: hPrecision, passed: holdoutPassed, reason },
      promoted: promotedThis,
    });

    if (promotedThis) {
      promoted.push({
        ruleId: `DISTILLED:${atom.id}`,
        type: "CLAIM_MISMATCH",
        atom: atom.id,
        explanation: atom.explanation,
        provenance: {
          jurors: consensus.jurorIds,
          effectiveJurors: consensus.effectiveJurors,
          meanPairwiseCorrelation: consensus.meanPairwiseCorrelation,
          consensusGate: cfg.consensusGate,
          derivationPrecision: dPrecision ?? 0,
          derivationSupport: dAgreed,
          holdoutPrecision: hPrecision ?? 0,
          holdoutSupport: hFires.length,
          splitSeed: cfg.splitSeed,
          splitFraction: cfg.splitFraction,
        },
      });
    }
  }

  // REPLACEABLE FRACTION — a residual row is "resolved" if ANY promoted rule fires on it.
  const resolves = (r: GroundTruthSample): boolean =>
    promoted.some((p) => cfg.atoms.find((a) => a.id === p.atom)?.fires(r.input));
  const holdoutResolved = holdout.filter((i) => resolves(residual[i])).length;
  const fullResolved = residual.filter(resolves).length;

  const residualBefore = n;
  const residualAfter = n - fullResolved;
  return {
    n,
    derivationN: derivation.length,
    holdoutN: holdout.length,
    effectiveJurors: consensus.effectiveJurors,
    meanPairwiseCorrelation: consensus.meanPairwiseCorrelation,
    candidates,
    promoted,
    replaceable: {
      holdoutResolved,
      holdoutN: holdout.length,
      replaceableFractionHoldout: holdout.length === 0 ? 0 : holdoutResolved / holdout.length,
      fullResolved,
      replaceableFractionFull: n === 0 ? 0 : fullResolved / n,
    },
    coverage: {
      corpusN,
      residualBefore,
      deterministicCoverageBefore: corpusN === 0 ? 0 : (corpusN - residualBefore) / corpusN,
      deterministicCoverageAfter: corpusN === 0 ? 0 : (corpusN - residualAfter) / corpusN,
      residualJudgeRateBefore: corpusN === 0 ? 0 : residualBefore / corpusN,
      residualJudgeRateAfter: corpusN === 0 ? 0 : residualAfter / corpusN,
    },
  };
}

// ── the promoted ruleset: a real, always-on deterministic detector over the residual ─────────────────────

/** Apply the promoted (distilled) rules to one input, returning DETERMINISTIC CLAIM_MISMATCH findings
 *  (llmAssisted: false — these are now rules, not a model) that cite the structural reason they fired.
 *  Resolves each rule's predicate from `atoms` by id (so a PromotedRule stays canonical/serializable). */
export function applyPromotedRules(
  input: DiffInput,
  rules: readonly PromotedRule[],
  atoms: readonly CandidateAtom[] = ATOM_LIBRARY,
): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    const atom = atoms.find((a) => a.id === rule.atom);
    if (atom && atom.fires(input)) {
      out.push({
        type: "CLAIM_MISMATCH",
        dimension: "scope",
        severity: "medium",
        claimedRef: input.claim.text || "(claim)",
        actualRef: input.evidence.excerpt || "(evidence)",
        llmAssisted: false,
        note: `distilled rule ${rule.ruleId} (holdout-gated, jury-receipted): ${rule.explanation}`,
      });
    }
  }
  return out;
}
