/**
 * Pacioli — the judge JURY (correlation-corrected EFFECTIVE-vote consensus over the CLAIM_MISMATCH residual).
 *
 * The cheap deterministic tier abstains on CLAIM_MISMATCH; the residual goes to the LLM judge. A single
 * judge sample is a noisy measurement, so this module asks a PANEL of jurors and aggregates them. The one
 * statistic that is easy to fake and must not be: the panel's STRENGTH is NOT its member count. Two jurors
 * that always agree carry roughly ONE independent vote, not two. So every consensus here reports the
 * CORRELATION-CORRECTED `effectiveJurors` (Kish's design-effect / effective sample size), never the raw m.
 *
 *   ρ̄              — the mean pairwise correlation of the jurors' 0/1 vote vectors across the residual.
 *   effectiveJurors — m / (1 + (m−1)·ρ̄), clamped to [1, m]. ρ̄→0 (independent) ⇒ ≈ m; ρ̄→1 (redundant) ⇒ ≈ 1.
 *
 * A row is "high-consensus" only when (a) the jurors AGREE strongly on it AND (b) the panel as a whole
 * carries enough EFFECTIVE independent votes to be worth trusting — so a chorus of clones cannot manufacture
 * confidence. This consensus is what the distillation layer (distill.ts) is allowed to mine into a candidate
 * deterministic rule, and what the selective-risk certificate (selective-risk.ts) certifies.
 *
 * ── KEYLESS vs GATED ────────────────────────────────────────────────────────────────────────────────────
 *   - KEYLESS: `mockJury()` is a DOCUMENTED synthetic panel of deterministic jurors reading DISTINCT facets
 *     of the keyless proxy (overall suspicion, lexical novelty, stated deviation, strong assertion) — a
 *     sizing/test instrument, NOT a measurement of any real model. The facets overlap, so the panel is
 *     correlated (the effective-vote correction visibly bites: effectiveJurors < m), yet diverse enough to
 *     reach a real consensus — and it lets the whole pipeline run with ZERO model spend.
 *   - GATED: `seedRealJury()` assembles the genuinely distinct, available LLM backends (hosted Anthropic,
 *     on-device Ollama) into a real panel. With no key / no Ollama it returns an EMPTY panel and the caller
 *     falls back to the keyless mock — it never fabricates jurors or disguises one backend as many.
 *
 * Pure aside from the injected jurors; the consensus math (`consensusFromVoteMatrix`) is a pure function of a
 * boolean vote matrix and is unit-tested directly.
 */

import type { DiffInput, Finding } from "@pacioli-app/engine";
import type { JudgeFn } from "./cascade";
import { mismatchScore } from "./conformal";
import { resolveJudge, type JudgeMode } from "./judge-router";

// ── jurors ──────────────────────────────────────────────────────────────────────────────────────────────

/** One panelist: a stable id plus a judge that returns CLAIM_MISMATCH findings (the cascade JudgeFn shape). */
export interface Juror {
  id: string;
  judge: JudgeFn;
}

const flagsClaimMismatch = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.type === "CLAIM_MISMATCH");

// ── per-row + panel results ───────────────────────────────────────────────────────────────────────────────

export interface JuryVote {
  jurorId: string;
  flag: boolean;
}

export interface JuryRow {
  votes: JuryVote[];
  /** Number of jurors that flagged CLAIM_MISMATCH. */
  flagCount: number;
  /** Fraction of the panel on the MAJORITY side ∈ [0.5, 1] — the per-row agreement strength. */
  agreement: number;
  /** Strict-majority verdict (ties resolve to "not flagged" — abstain rather than guess). */
  consensusFlag: boolean;
}

export interface JuryConsensus {
  jurorIds: string[];
  /** Raw panel size. NEVER the headline — see `effectiveJurors`. */
  m: number;
  /** Mean pairwise correlation of the juror vote vectors across the rows, clamped to [0,1] for the
   *  effective-count deflation (a constant juror counts as fully redundant, ρ=1 — the conservative read). */
  meanPairwiseCorrelation: number;
  /** Correlation-corrected effective independent votes: m / (1 + (m−1)·ρ̄), clamped to [1, m]. */
  effectiveJurors: number;
  rows: JuryRow[];
}

// ── correlation-corrected consensus (pure; the honesty core) ──────────────────────────────────────────────

/** Pearson correlation of two equal-length 0/1 vectors. A zero-variance (constant) juror carries no
 *  independent signal, so we treat its correlation as 1 (fully redundant) — the conservative choice that
 *  DEFLATES the effective count rather than overstating independence. */
function voteCorrelation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n === 0) return 1;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return 1; // a constant juror is perfectly redundant — no independent vote
  return cov / Math.sqrt(va * vb);
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Build the correlation-corrected consensus from a boolean vote matrix `votes[j][i]` (juror j on row i).
 * Pure: this is the unit under test for the effective-vote math, independent of any judge.
 */
export function consensusFromVoteMatrix(jurorIds: readonly string[], votes: readonly (readonly boolean[])[]): JuryConsensus {
  const m = jurorIds.length;
  const nRows = votes[0]?.length ?? 0;
  for (const row of votes) {
    if (row.length !== nRows) throw new RangeError("every juror must vote on the same number of rows");
  }

  // mean pairwise correlation over the juror vote vectors (0/1 across rows)
  const numeric = votes.map((v) => v.map((f) => (f ? 1 : 0)));
  let corrSum = 0;
  let pairs = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      corrSum += voteCorrelation(numeric[i], numeric[j]);
      pairs++;
    }
  }
  const rhoRaw = pairs === 0 ? 0 : corrSum / pairs;
  const rho = clamp(rhoRaw, 0, 1);
  const effectiveJurors = m === 0 ? 0 : clamp(m / (1 + (m - 1) * rho), 1, m);

  // per-row aggregation
  const rows: JuryRow[] = [];
  for (let i = 0; i < nRows; i++) {
    const rowVotes: JuryVote[] = jurorIds.map((id, j) => ({ jurorId: id, flag: votes[j][i] }));
    const flagCount = rowVotes.reduce((s, v) => s + (v.flag ? 1 : 0), 0);
    const consensusFlag = m > 0 && flagCount * 2 > m; // strict majority; ties → not flagged (abstain)
    const agreement = m === 0 ? 0 : Math.max(flagCount, m - flagCount) / m;
    rows.push({ votes: rowVotes, flagCount, agreement, consensusFlag });
  }

  return { jurorIds: [...jurorIds], m, meanPairwiseCorrelation: rho, effectiveJurors, rows };
}

/** Run a panel of jurors over the inputs (one judge call per juror per input) and aggregate. */
export async function runJury(jurors: readonly Juror[], inputs: readonly DiffInput[]): Promise<JuryConsensus> {
  const votes: boolean[][] = [];
  for (const juror of jurors) {
    const row: boolean[] = [];
    for (const input of inputs) row.push(flagsClaimMismatch(await juror.judge(input)));
    votes.push(row);
  }
  return consensusFromVoteMatrix(jurors.map((j) => j.id), votes);
}

// ── the high-consensus gate (what distillation is allowed to mine) ────────────────────────────────────────

export interface ConsensusGate {
  /** Minimum per-row agreement fraction (e.g. 2/3) for a row to count as a confident agreement. */
  minAgreement: number;
  /** Minimum panel-wide EFFECTIVE independent votes — a chorus of clones (low effectiveJurors) cannot pass. */
  minEffectiveJurors: number;
}

export const DEFAULT_CONSENSUS_GATE: ConsensusGate = { minAgreement: 2 / 3, minEffectiveJurors: 1.5 };

/** True iff the row is a confident CLAIM_MISMATCH agreement AND the panel carries enough effective votes. */
export function isHighConsensusMismatch(row: JuryRow, consensus: JuryConsensus, gate: ConsensusGate = DEFAULT_CONSENSUS_GATE): boolean {
  return row.consensusFlag && row.agreement >= gate.minAgreement && consensus.effectiveJurors >= gate.minEffectiveJurors;
}

// ── KEYLESS mock jury (a DOCUMENTED synthetic instrument, not a measurement) ──────────────────────────────

/** A deterministic, keyless juror that flags CLAIM_MISMATCH iff `predicate(input)` holds. NOT a model — a
 *  sizing/test instrument with a stable, human-legible reason. */
export function facetJuror(id: string, reason: string, predicate: (input: DiffInput) => boolean): Juror {
  return {
    id,
    judge: async (input: DiffInput): Promise<Finding[]> => {
      if (!predicate(input)) return [];
      return [
        {
          type: "CLAIM_MISMATCH",
          dimension: "scope",
          severity: "medium",
          claimedRef: input.claim.text || "(claim)",
          actualRef: input.evidence.excerpt || "(evidence)",
          llmAssisted: true,
          note: `mock juror ${id} (${reason}; synthetic sizing instrument, not a real model)`,
        },
      ];
    },
  };
}

/** A keyless juror that flags iff the transparent overall mismatch-score proxy (conformal.ts) ≥ `threshold`. */
export function scoreThresholdJuror(id: string, threshold: number): Juror {
  return facetJuror(id, `keyless proxy ≥ ${threshold}`, (input) => mismatchScore(input).score >= threshold);
}

/**
 * The KEYLESS mock jury: a DIVERSE panel of deterministic jurors reading DISTINCT facets of the keyless
 * proxy — overall suspicion, lexical novelty, stated deviation, and strong assertion. The facets overlap so
 * the panel is correlated (effectiveJurors < m, the correction bites) yet diverse enough to reach a genuine
 * consensus. Deterministic, zero-spend; with a key, replace it with `seedRealJury`.
 */
export function mockJury(): Juror[] {
  return [
    facetJuror("breadth", "overall keyless suspicion ≥ 0.30", (i) => mismatchScore(i).score >= 0.3),
    facetJuror("novelty", "claim asserts ≥ 55% tokens absent from the evidence", (i) => mismatchScore(i).components.lexicalNovelty >= 0.55),
    facetJuror("deviation", "evidence reports a deviation/substitution", (i) => mismatchScore(i).components.divergence >= 1),
    facetJuror("assertion", "claim makes an unverifiable superlative or a conflicting date claim", (i) => {
      const c = mismatchScore(i).components;
      return c.qualifier >= 1 || c.dateConflict >= 1;
    }),
  ];
}

// ── GATED real jury (assembles only the genuinely distinct backends that are actually available) ──────────

export interface RealJurySeed {
  jurors: Juror[];
  /** Backends that were available and seeded as jurors. */
  available: string[];
  /** True iff ≥ 2 distinct backends are available — below that it is NOT a jury and the caller must say so. */
  isJury: boolean;
  note: string;
}

/**
 * Seed a REAL jury from the distinct, available LLM backends (hosted Anthropic, on-device Ollama). Gated
 * honestly: each backend is included only if `resolveJudge` reports it available. Fewer than two distinct
 * backends is NOT a jury (a single noisy judge cannot vote against itself) — we say so and let the caller
 * fall back to the keyless mock. We never duplicate one backend to pad the member count.
 */
export async function seedRealJury(): Promise<RealJurySeed> {
  const jurors: Juror[] = [];
  const available: string[] = [];
  for (const mode of ["anthropic", "local"] as JudgeMode[]) {
    const resolved = await resolveJudge(mode);
    if (resolved.available && resolved.mode !== "off") {
      jurors.push({ id: resolved.mode, judge: resolved.judge });
      available.push(resolved.mode);
    }
  }
  const isJury = jurors.length >= 2;
  const note = isJury
    ? `real jury seeded from ${available.length} distinct backends: ${available.join(", ")}`
    : `only ${available.length} distinct backend(s) available (${available.join(", ") || "none"}) — NOT a jury; ` +
      `fall back to the keyless mock and report effective votes honestly`;
  return { jurors, available, isJury, note };
}
