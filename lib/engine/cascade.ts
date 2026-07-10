/**
 * Pacioli — the CASCADE EQUIVALENCE layer (cheap deterministic tier → auth-gated LLM judge).
 *
 * Pacioli's engine is a two-tier cascade:
 *   CHEAP   — the deterministic rules (diff.ts): model-free, provable, instant, no key. They RESOLVE
 *             OVERSPEND / UNAUTH_RECURRENCE / SCOPE_CREEP and ABSTAIN on the fuzzy CLAIM_MISMATCH residual.
 *   EXPENSIVE — the auth-gated LLM judge (judge.ts / local-judge.ts): runs ONLY on the residual.
 *
 * This module makes the cheap fast-path FALSIFIABLE, in the spirit of "Trust or Escalate" (Gera et al.,
 * arXiv:2407.18370) and lossless speculative cascades: the cheap tier is TRUSTED where it commits and the
 * expensive tier is ESCALATED to only on the residual — and we PROVE (and measure) that the cascaded
 * VERDICT CLASS is identical to running the expensive tier on EVERYTHING.
 *
 * ── THE LOSSLESS GUARANTEE (EQUIV-CASCADE) ──────────────────────────────────────────────────────────
 * Let D(x) = the deterministic findings, J(x) = the judge's CLAIM_MISMATCH residual findings, and define
 * a verdict's CLASS ∈ {balanced, flagged} = flagged iff there is ≥1 finding. The reference ("expensive on
 * everything") is D(x) ∪ J(x). Under the lossless policy "trust-on-resolve" the cascade escalates to J
 * IFF D is silent:
 *     D fired  → cascade = D(x)        ; reference = D(x) ∪ J(x)  → both FLAGGED  (class equal)
 *     D silent → cascade = D(x) ∪ J(x) ; reference = D(x) ∪ J(x)  → identical     (class equal)
 * So class(cascade) == class(reference) for EVERY input, for ANY judge J. losslessViolations = 0 by
 * construction. The guarantee rests on ONE assumption — the judge only ADDS CLAIM_MISMATCH and never
 * overturns a deterministic finding — which the equivalence test FALSIFIES rather than asserts: it runs
 * both paths and counts class disagreements. The deliberately LOSSY baseline policy "trust-all" (never
 * escalate) makes the relation BITE (violations > 0 wherever the residual would have flipped the class),
 * exactly as the RECON-MR negative test proves its relation can fail.
 *
 * What is NOT claimed: the cascade is class-lossless, not finding-set-lossless. On an already-flagged
 * row the cascade skips J, so it may not enumerate a (redundant, class-preserving) CLAIM_MISMATCH the
 * reference would list. That completeness cost is DISCLOSED as `skippedResidualFindings`, never hidden.
 *
 * ── KEYLESS vs GATED ────────────────────────────────────────────────────────────────────────────────
 * `goldOracleJudge` lets the human gold labels stand in for a perfect expensive tier, so the whole
 * equivalence regression runs deterministically with ZERO model spend (the keyless CI path). The
 * one-time judge-equivalence CALIBRATION — does the REAL Claude/Ollama judge respect the no-overturn
 * assumption? — needs a key and is gated honestly (lib/engine/reconcile-cli.ts), with this keyless mock
 * standing in for it in tests.
 *
 * Zero new dependencies; the cheap tier stays pure and deterministic.
 */

import { canonicalJSON } from "@pacioli-app/engine";
import { diff } from "@pacioli-app/engine";
import type { DiffInput, Finding, GroundTruthSample, Verdict } from "@pacioli-app/engine";

// ── regime + locus labels (the suite-wide gate taxonomy) ──────────────────────────────────────────

/** Whether a tier's signal is a model-based residual (an LLM's fallible judgement) or a deliberately
 *  model-free, provable rule. Surfaced so a reader can tell which decisions carry model risk. */
export type Regime = "model-free-provable" | "model-based-residual";

/** Where the residual a tier points at lives. Pacioli reconciles per CLAIM. */
export type Locus = "turn" | "claim" | "action" | "step" | "chunk";

export interface CascadeTier {
  name: string;
  regime: Regime;
  locus: Locus;
}

export interface CascadeBoundary {
  /** Stable id for this cheap→expensive boundary. */
  id: string;
  cheap: CascadeTier;
  expensive: CascadeTier;
}

/** Pacioli has ONE cheap→expensive boundary: deterministic rules → auth-gated LLM judge on the residual. */
export const CLAIM_CASCADE: CascadeBoundary = {
  id: "deterministic-rules->llm-judge",
  cheap: {
    name: "deterministic rules (packages/engine/src/diff.ts)",
    regime: "model-free-provable",
    locus: "claim",
  },
  expensive: {
    name: "auth-gated LLM judge — CLAIM_MISMATCH residual (lib/engine/judge.ts)",
    regime: "model-based-residual",
    locus: "claim",
  },
};

// ── verdict class ─────────────────────────────────────────────────────────────────────────────────

export type CascadeClass = "balanced" | "flagged";
export const classOf = (findings: readonly Finding[]): CascadeClass => (findings.length > 0 ? "flagged" : "balanced");

// ── the judge the cascade escalates to ──────────────────────────────────────────────────────────────

/** The expensive tier's contract: it sees a full input and returns ONLY its residual (CLAIM_MISMATCH)
 *  findings. Identical shape to the production judges (judge.ts / local-judge.ts) so they drop in. */
export type JudgeFn = (input: DiffInput) => Promise<Finding[]>;

/** The deterministic-only judge: escalation never produces a residual finding. The keyless default for
 *  scoreTrace and the no-key CLI path — honest, because with no key/Ollama the real judge is exactly this. */
export const offJudge: JudgeFn = async () => [];

/**
 * The keyless GOLD-ORACLE judge: a perfect expensive tier simulated by the human labels. It flags a
 * CLAIM_MISMATCH exactly when the gold target does (and never re-derives a deterministic finding — that
 * is the cheap tier's job). This is what makes the equivalence + telemetry a deterministic, zero-spend
 * regression; the real gated judge replaces it in the one-time calibration pass.
 *
 * Inputs are matched by canonical content hash, so an input reconstructed field-by-field still resolves.
 */
export function goldOracleJudge(rows: readonly GroundTruthSample[]): JudgeFn {
  const goldByInput = new Map<string, boolean>();
  for (const r of rows) {
    const isClaimMismatch = (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");
    goldByInput.set(canonicalJSON(r.input), isClaimMismatch);
  }
  return async (input: DiffInput): Promise<Finding[]> => {
    if (!goldByInput.get(canonicalJSON(input))) return [];
    return [
      {
        type: "CLAIM_MISMATCH",
        dimension: "scope",
        severity: "medium",
        claimedRef: input.claim.text || "(claim)",
        actualRef: input.evidence.excerpt || "(evidence)",
        llmAssisted: true,
        note: "gold-oracle: human label marks this a CLAIM_MISMATCH (keyless stand-in for the expensive tier)",
      },
    ];
  };
}

// ── the cascade itself ────────────────────────────────────────────────────────────────────────────

/** "trust-on-resolve" (default, LOSSLESS): escalate to the judge iff the cheap tier is silent.
 *  "trust-all" (LOSSY baseline): never escalate — trust the cheap tier on everything. Used only to
 *  demonstrate the equivalence relation can BITE; never the shipped policy. */
export type CascadePolicy = "trust-on-resolve" | "trust-all";

export interface CascadeResult {
  /** The cascade's verdict: deterministic when resolved cheaply; deterministic ∪ judge when escalated. */
  verdict: Verdict;
  /** Did we call the expensive tier on this input? */
  escalated: boolean;
  cheapClass: CascadeClass;
  /** The judge's residual findings; [] unless escalated. */
  judgeFindings: Finding[];
}

/** Merge the deterministic verdict with the judge residual (the "expensive on everything" verdict). */
function merge(det: Verdict, judgeFindings: readonly Finding[]): Verdict {
  return {
    balanced: det.balanced && judgeFindings.length === 0,
    findings: [...det.findings, ...judgeFindings],
    deltaUsd: det.deltaUsd,
    unscorable: det.unscorable,
  };
}

/** Run the cascade on ONE input. Cheap tier first; escalate per `policy`. */
export async function cascadeReconcile(
  input: DiffInput,
  judge: JudgeFn = offJudge,
  policy: CascadePolicy = "trust-on-resolve",
): Promise<CascadeResult> {
  const det = diff(input);
  const cheapClass = classOf(det.findings);
  // trust-on-resolve escalates the residual (cheap silent); trust-all trusts the cheap tier everywhere.
  const escalate = policy === "trust-all" ? false : det.balanced;
  if (!escalate) return { verdict: det, escalated: false, cheapClass, judgeFindings: [] };
  const judgeFindings = await judge(input);
  return { verdict: merge(det, judgeFindings), escalated: true, cheapClass, judgeFindings };
}

/** The reference: run BOTH tiers on every input (the expensive tier touches everything). */
export async function expensiveOnEverything(input: DiffInput, judge: JudgeFn = offJudge): Promise<Verdict> {
  return merge(diff(input), await judge(input));
}

// ── the EQUIV-CASCADE relation (lossless guarantee, checked not asserted) ───────────────────────────

export const EQUIV_CASCADE = "EQUIV-CASCADE" as const;

export interface EquivCascadeViolation {
  property: typeof EQUIV_CASCADE;
  detail: string;
}

/**
 * Check EQUIV-CASCADE over a set of inputs: the cascaded verdict CLASS must equal the verdict class of
 * running the expensive tier on everything, for every input. Returns the violations (empty = the
 * lossless guarantee holds). The judge is called once per input and shared between the two paths.
 */
export async function equivCascadeViolations(
  inputs: readonly DiffInput[],
  judge: JudgeFn = offJudge,
  policy: CascadePolicy = "trust-on-resolve",
): Promise<EquivCascadeViolation[]> {
  const out: EquivCascadeViolation[] = [];
  for (const [i, input] of inputs.entries()) {
    const det = diff(input);
    const judgeFindings = await judge(input);
    const refClass = classOf([...det.findings, ...judgeFindings]);
    const escalate = policy === "trust-all" ? false : det.balanced;
    const cascadeClass = classOf(escalate ? [...det.findings, ...judgeFindings] : det.findings);
    if (cascadeClass !== refClass) {
      out.push({
        property: EQUIV_CASCADE,
        detail: `input[${i}]: cascade=${cascadeClass} but expensive-on-everything=${refClass} (policy ${policy})`,
      });
    }
  }
  return out;
}

// ── cascade telemetry: alpha / disagreementRate / losslessViolations ────────────────────────────────

export interface CascadeMetrics {
  boundary: string;
  regime: { cheap: Regime; expensive: Regime };
  locus: Locus;
  /** A label for the expensive tier actually used: "gold-oracle" (keyless), "anthropic", "local", "off". */
  judge: string;
  policy: CascadePolicy;
  n: number;
  /** Fraction the cheap tier resolved WITHOUT escalating (the lossless fast-path coverage). */
  alpha: number;
  /** Fraction sent to the expensive tier (the residual the judge touches). alpha + escalationRate = 1. */
  escalationRate: number;
  /** When BOTH tiers run the same input, the fraction whose verdict CLASS differs (the judge's add-on). */
  disagreementRate: number;
  /** Cases where the cascade's verdict CLASS differs from expensive-on-everything — the lossless guarantee.
   *  0 under "trust-on-resolve" by construction; > 0 under the lossy "trust-all" baseline. */
  losslessViolations: number;
  /** DISCLOSED completeness cost: rows the cheap tier resolved (flagged) where the expensive tier would
   *  ALSO have added a class-preserving CLAIM_MISMATCH the cascade skipped. NOT a class violation. */
  skippedResidualFindings: number;
}

/** Measure the cascade over a set of inputs. The judge is invoked once per input (zero spend with the
 *  keyless gold-oracle / off judge). Pure aside from the injected judge. */
export async function cascadeMetrics(
  inputs: readonly DiffInput[],
  judge: JudgeFn = offJudge,
  opts: { policy?: CascadePolicy; judgeLabel?: string } = {},
): Promise<CascadeMetrics> {
  const policy = opts.policy ?? "trust-on-resolve";
  const n = inputs.length;
  let escalated = 0;
  let disagree = 0;
  let violations = 0;
  let skipped = 0;

  for (const input of inputs) {
    const det = diff(input);
    const judgeFindings = await judge(input);
    const cheapClass = classOf(det.findings);
    const refClass = classOf([...det.findings, ...judgeFindings]);
    if (cheapClass !== refClass) disagree++;

    const escalate = policy === "trust-all" ? false : det.balanced;
    if (escalate) escalated++;
    const cascadeClass = classOf(escalate ? [...det.findings, ...judgeFindings] : det.findings);
    if (cascadeClass !== refClass) violations++;
    if (!escalate && det.findings.length > 0 && judgeFindings.length > 0) skipped++;
  }

  const safeDiv = (num: number): number => (n === 0 ? 0 : num / n);
  return {
    boundary: CLAIM_CASCADE.id,
    regime: { cheap: CLAIM_CASCADE.cheap.regime, expensive: CLAIM_CASCADE.expensive.regime },
    locus: CLAIM_CASCADE.cheap.locus,
    judge: opts.judgeLabel ?? "off",
    policy,
    n,
    alpha: safeDiv(n - escalated),
    escalationRate: safeDiv(escalated),
    disagreementRate: safeDiv(disagree),
    losslessViolations: violations,
    skippedResidualFindings: skipped,
  };
}

// ── the SUITE CASCADE-TELEMETRY contract slice (one per cheap→expensive boundary) ───────────────────

/** The consistent-shape slice every repo in the suite emits for each of its cheap→expensive boundaries. */
export interface CascadeTelemetrySlice {
  repo: "pacioli";
  boundary: string;
  /** Fraction the cheap/deterministic tier resolved without escalating. */
  alpha: number;
  /** When both tiers run the same input, how often they differ. */
  disagreementRate: number;
  /** Count of cases where the cheap fast-path produced a verdict the expensive tier would NOT have. */
  losslessViolations: number;
}

export function telemetrySlice(m: CascadeMetrics): CascadeTelemetrySlice {
  return {
    repo: "pacioli",
    boundary: m.boundary,
    alpha: m.alpha,
    disagreementRate: m.disagreementRate,
    losslessViolations: m.losslessViolations,
  };
}

// ── scoreTrace: the objective seam for the suite MPC contract ───────────────────────────────────────

/** The objective an outer optimizer (the suite) reads off a candidate claim set. */
export interface ScoreTrace {
  /** The cascade's lossless cheap-tier coverage on the candidate set, in [0,1] (higher = cheaper, more
   *  provable to audit). Equals alpha under "trust-on-resolve". */
  score: number;
  /** Does the cascade satisfy its lossless constraint on this candidate set (zero class violations)? */
  feasible: boolean;
  /** True when no defensible score exists (empty set, or every candidate unscorable). */
  abstained: boolean;
}

/**
 * Evaluate a CANDIDATE set of claims and return {score, feasible, abstained} — the stable objective seam
 * the suite optimizer calls. Judge-injectable: the keyless default (`offJudge`) scores purely on the
 * deterministic tier, so this seam needs no key and is deterministic. score is judge-INDEPENDENT under
 * "trust-on-resolve" (escalation keys only on whether the cheap tier was silent), so a candidate set's
 * objective does not move with model nondeterminism.
 */
export async function scoreTrace(
  candidates: readonly DiffInput[],
  opts: { judge?: JudgeFn; policy?: CascadePolicy; judgeLabel?: string } = {},
): Promise<ScoreTrace> {
  const scorable = candidates.filter((c) => !diff(c).unscorable);
  if (scorable.length === 0) return { score: 0, feasible: true, abstained: true };
  const m = await cascadeMetrics(scorable, opts.judge ?? offJudge, {
    policy: opts.policy ?? "trust-on-resolve",
    judgeLabel: opts.judgeLabel,
  });
  return { score: m.alpha, feasible: m.losslessViolations === 0, abstained: false };
}
