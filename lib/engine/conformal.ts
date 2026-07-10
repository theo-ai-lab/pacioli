/**
 * Pacioli — a CONFORMAL-CALIBRATED continuous residual band on CLAIM_MISMATCH (locus = the CLAIM).
 *
 * The cheap deterministic tier abstains on CLAIM_MISMATCH; the naive-lossless cascade therefore escalates
 * EVERY non-flagged claim to the judge (you cannot certify "balanced" with a rule). This module is the
 * refinement from "Trust or Escalate" (arXiv:2407.18370): attach a CONTINUOUS, keyless residual score to
 * each claim and use split-conformal prediction to carve out a calibrated TRUST zone — claims confident
 * enough to resolve cheaply — leaving only an UNCERTAIN BAND to escalate, with a distribution-free
 * coverage guarantee.
 *
 *   score s(x) ∈ [0,1]  — a deterministic, keyless proxy for "this claim looks like a CLAIM_MISMATCH".
 *   split conformal     — on a CALIBRATION split with gold labels, take the finite-sample (1−α) quantile
 *                         of the class-conditional nonconformity scores → two thresholds τ_lo ≤ τ_hi.
 *   the band            — s ≤ τ_lo → confidently OK; s ≥ τ_hi → confidently MISMATCH; in between (or both)
 *                         → ESCALATE. The conformal guarantee: the true label lies in the predicted set
 *                         with probability ≥ 1−α (marginally, exchangeability assumed).
 *
 * HONESTY BAR:
 *   - The score is a PROXY, not the judge. Its absolute value is not trusted; conformal calibration is
 *     exactly what converts an un-trusted score into a coverage-controlled gate. If the proxy carries no
 *     signal, the band collapses to "escalate everything" — the SAFE failure, never false trust.
 *   - The coverage guarantee is finite-sample (the ceil((n+1)(1−α))/n quantile), distribution-free. At
 *     n in the tens it is WIDE: we report empirical coverage on a HELD-OUT split scored ONCE, with a
 *     Wilson CI, and never quote a tight coverage number as if it were the real judge's.
 *   - We calibrate at a SINGLE α. Scanning α and reporting the best would be multiplicity-hacking; if you
 *     do scan, Bonferroni/BH-correct. The split is seeded and deterministic so the "scored once" holds.
 *
 * Zero dependencies beyond the existing Wilson interval; pure and deterministic.
 */

import { mulberry32 } from "./fuzz";
import { wilsonInterval } from "./judge-eval";
import type { DiffInput } from "@pacioli-app/engine";

// ── the keyless mismatch-score proxy (locus = the claim) ────────────────────────────────────────────

const QUALIFIERS = [
  "cheapest",
  "lowest",
  "best",
  "fastest",
  "nonstop",
  "only",
  "earliest",
  "latest",
  "shortest",
  "nearest",
  "guaranteed",
  "refundable",
];
const DIVERGENCE = ["not ", "n't", "instead", "unable", "declined", "different", "unavailable", "sold out", "cancel"];
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "on", "in", "at", "and", "or", "with", "your", "you", "it",
  "is", "was", "were", "be", "been", "i", "we", "they", "this", "that", "made", "no", "all",
]);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$. ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** A four-letter date-ish signature (YYYY-MM-DD or "the 14th" style ordinals) for a crude disagreement check. */
const dateTokens = (s: string): Set<string> => {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) out.add(m[1]);
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) out.add(m[1]);
  return out;
};

export interface ScoreComponents {
  /** Claim/task asserts an unverifiable superlative ("cheapest", "nonstop") the evidence rarely confirms. */
  qualifier: number;
  /** Content tokens in the claim absent from the evidence — the claim asserts more than the evidence backs. */
  lexicalNovelty: number;
  /** A date in the claim disagrees with a date in the evidence. */
  dateConflict: number;
  /** The evidence carries divergence/negation language ("instead", "unable", "different"). */
  divergence: number;
}

/**
 * A transparent, deterministic, KEYLESS suspicion score in [0,1] for "this claim is a CLAIM_MISMATCH",
 * pointed at the CLAIM. A crude proxy by design — calibrated, not trusted. Returns the score plus its
 * components so the signal is auditable, never a black box.
 */
export function mismatchScore(input: DiffInput): { score: number; components: ScoreComponents } {
  const claimText = `${input.claim.task} ${input.claim.text} ${(input.claim.authorized.constraints ?? []).join(" ")}`;
  const evidenceText = `${input.evidence.merchant} ${input.evidence.excerpt} ${input.evidence.items.join(" ")}`;

  const claimLower = claimText.toLowerCase();
  const qualifier = QUALIFIERS.some((q) => claimLower.includes(q)) ? 1 : 0;

  const claimTokens = tokens(claimText);
  const evidenceSet = new Set(tokens(evidenceText));
  const novel = claimTokens.filter((t) => !evidenceSet.has(t)).length;
  const lexicalNovelty = claimTokens.length === 0 ? 0 : novel / claimTokens.length;

  const claimDates = dateTokens(claimText);
  const evidenceDates = dateTokens(`${evidenceText} ${input.evidence.date ?? ""}`);
  let dateConflict = 0;
  if (claimDates.size > 0 && evidenceDates.size > 0) {
    const overlap = [...claimDates].some((d) => evidenceDates.has(d));
    dateConflict = overlap ? 0 : 1;
  }

  const evidenceLower = evidenceText.toLowerCase();
  const divergence = DIVERGENCE.some((d) => evidenceLower.includes(d)) ? 1 : 0;

  const components: ScoreComponents = { qualifier, lexicalNovelty, dateConflict, divergence };
  // Equal-weighted mean of the four normalized components. Documented and flat on purpose — a tuned
  // weight vector reported as if learned would be slop; the conformal layer does the calibration.
  const score = (qualifier + lexicalNovelty + dateConflict + divergence) / 4;
  return { score: Math.min(1, Math.max(0, score)), components };
}

// ── split-conformal calibration ─────────────────────────────────────────────────────────────────────

export interface LabeledScore {
  score: number;
  /** Gold: is this claim truly a CLAIM_MISMATCH? */
  gold: boolean;
}

export interface ConformalBand {
  /** Target miscoverage. The set covers the true label with probability ≥ 1−alpha (exchangeability). */
  alpha: number;
  /** s ≤ tauLo → "ok" is admitted to the prediction set. */
  tauLo: number;
  /** s ≥ tauHi → "mismatch" is admitted to the prediction set. */
  tauHi: number;
  /** Calibration support per class (the quantile's denominator — small n ⇒ a wide, weak guarantee). */
  nOk: number;
  nMismatch: number;
}

/** The finite-sample conformal quantile of `scores` at level (1−alpha): the ceil((n+1)(1−alpha))-th
 *  smallest nonconformity. When that rank exceeds n the quantile is the trivial bound `cap` (admit all). */
function conformalQuantile(scores: number[], alpha: number, cap: number): number {
  const n = scores.length;
  if (n === 0) return cap; // no calibration evidence for this class → admit it everywhere (escalate-safe)
  const rank = Math.ceil((n + 1) * (1 - alpha));
  if (rank > n) return cap;
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted[rank - 1];
}

/**
 * Fit a class-conditional split-conformal band from a CALIBRATION set. Nonconformity for the "mismatch"
 * class is (1−s) and for the "ok" class is s; the (1−alpha) quantile of each becomes a threshold:
 *   τ_hi = 1 − q_mismatch   (admit "mismatch" when s ≥ τ_hi)
 *   τ_lo =     q_ok         (admit "ok"       when s ≤ τ_lo)
 */
export function fitConformalBand(calibration: readonly LabeledScore[], alpha = 0.1): ConformalBand {
  const okScores = calibration.filter((c) => !c.gold).map((c) => c.score);
  const cmScores = calibration.filter((c) => c.gold).map((c) => c.score);
  const qOk = conformalQuantile(okScores, alpha, 1);
  const qMismatch = conformalQuantile(cmScores.map((s) => 1 - s), alpha, 1);
  return {
    alpha,
    tauLo: qOk,
    tauHi: 1 - qMismatch,
    nOk: okScores.length,
    nMismatch: cmScores.length,
  };
}

export type BandDecision = "ok" | "mismatch" | "escalate";

/**
 * Classify one claim's score against the band. A SINGLETON prediction set is a confident, cheaply-resolved
 * decision; an empty set (uncertain) OR a two-element set (ambiguous) is the ESCALATE zone — the residual
 * the expensive judge actually touches.
 */
export function bandDecision(score: number, band: ConformalBand): BandDecision {
  const admitOk = score <= band.tauLo;
  const admitMismatch = score >= band.tauHi;
  if (admitOk && !admitMismatch) return "ok";
  if (admitMismatch && !admitOk) return "mismatch";
  return "escalate"; // {} (uncertain) or {ok, mismatch} (ambiguous)
}

// ── held-out coverage evaluation (scored ONCE) ──────────────────────────────────────────────────────

export interface CoverageReport {
  n: number;
  /** Fraction of held-out claims whose TRUE label is in the conformal prediction set (the empirical
   *  coverage; the guarantee says this should be ≥ 1−alpha in expectation). */
  coverage: number;
  /** Wilson 95% CI on the empirical coverage — wide at small n, reported honestly as such. */
  coverageCI: { low: number; high: number };
  /** Fraction of held-out claims that landed in the ESCALATE zone (sent to the judge). */
  escalationRate: number;
  /** Fraction CHEAPLY resolved as a confident singleton (1 − escalationRate). */
  trustRate: number;
  /** Of the cheaply-resolved singletons, the fraction whose singleton matched gold (selective accuracy). */
  selectiveAccuracy: number | null;
}

/** True iff the true label is in the conformal prediction set for `score`. */
function covered(score: number, gold: boolean, band: ConformalBand): boolean {
  const admitOk = score <= band.tauLo;
  const admitMismatch = score >= band.tauHi;
  return gold ? admitMismatch : admitOk;
}

/** Evaluate a band on a HELD-OUT split (call ONCE on the test split that was not used to fit). */
export function evaluateCoverage(test: readonly LabeledScore[], band: ConformalBand): CoverageReport {
  const n = test.length;
  if (n === 0) {
    return { n: 0, coverage: 0, coverageCI: { low: 0, high: 1 }, escalationRate: 0, trustRate: 0, selectiveAccuracy: null };
  }
  let coveredCount = 0;
  let escalated = 0;
  let resolved = 0;
  let resolvedCorrect = 0;
  for (const t of test) {
    if (covered(t.score, t.gold, band)) coveredCount++;
    const d = bandDecision(t.score, band);
    if (d === "escalate") escalated++;
    else {
      resolved++;
      if ((d === "mismatch") === t.gold) resolvedCorrect++;
    }
  }
  return {
    n,
    coverage: coveredCount / n,
    coverageCI: wilsonInterval(coveredCount, n),
    escalationRate: escalated / n,
    trustRate: resolved / n,
    selectiveAccuracy: resolved === 0 ? null : resolvedCorrect / resolved,
  };
}

// ── a deterministic, seeded calibration/test split (so "scored once" is reproducible) ────────────────

export function splitCalibTest<T>(rows: readonly T[], fraction = 0.5, seed = 1234): { calib: T[]; test: T[] } {
  const rng = mulberry32(seed);
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const cut = Math.floor(rows.length * fraction);
  return {
    calib: idx.slice(0, cut).map((i) => rows[i]),
    test: idx.slice(cut).map((i) => rows[i]),
  };
}
