/**
 * Pacioli — judge sample-k SATURATION curve on a FIXED gold set.
 *
 * The expensive tier (the LLM judge) is STOCHASTIC: ask it twice, it can answer differently. The usual
 * fix is to sample it k times and majority-vote. This module answers ONE sizing question on a FIXED gold
 * set: how many samples k before majority-vote stops improving — i.e. where does the curve SATURATE, and
 * what is the irreducible floor it cannot pass?
 *
 *   - Variance the votes CAN remove: per-row sampling noise. By Condorcet's jury theorem, for a row where
 *     the judge leans the right way (flip-probability p ≠ 1/2), majority-vote accuracy is monotone in odd
 *     k and converges to the consensus answer. More samples buy you the consensus, nothing more.
 *   - The floor the votes CANNOT remove: rows where the judge is a coin flip (p ≈ 1/2). No amount of
 *     sampling resolves them — that is GOLD AMBIGUITY (the case is genuinely undecidable for the judge),
 *     not sampling noise. We surface it explicitly as `irreducibleAmbiguity`.
 *
 * HONESTY BAR (the part that is easy to fake and must not be):
 *   - This is a SAMPLE-k curve on a FIXED set. We never extrapolate an asymptote over gold-set SIZE n —
 *     that is the indefensible move at n in the tens. Only the k-axis is swept; n is held fixed.
 *   - `saturationCurve` is a PURE FUNCTION of a per-row flip-probability vector + gold. The honest input
 *     is the EMPIRICAL flip-frequency from k live judge samples (gated, needs a key). For the keyless
 *     path, `syntheticJudgeInstrument` builds a DOCUMENTED stochastic-judge model — a sizing instrument,
 *     NOT a measurement of any real judge's accuracy — so the math (monotonicity, saturation, the
 *     ambiguity floor) can be tested with zero model spend.
 *
 * Zero dependencies; exact binomial arithmetic in double precision.
 */

/** A fixed gold row's stochastic-judge parameters: the judge's per-sample probability of flagging this
 *  row as a CLAIM_MISMATCH (`flagProb`), and the human gold label (`goldFlag`). */
export interface JudgeRow {
  /** P(one judge sample flags CLAIM_MISMATCH) ∈ [0,1]. Empirical flip-frequency over live samples, or a
   *  documented synthetic value for the keyless sizing instrument. */
  flagProb: number;
  /** The human gold label: is this row truly a CLAIM_MISMATCH? */
  goldFlag: boolean;
}

/** Rows whose flip-probability is within `eps` of 1/2 are coin flips — irreducibly ambiguous to the
 *  judge regardless of k. The default band is deliberately tight. */
export const AMBIGUITY_EPS = 0.05;

/**
 * P(majority of k iid Bernoulli(p) draws are 1), with k ODD so there are no ties. Computed by summing the
 * upper binomial tail from the majority threshold via a stable iterative pmf (no factorials, no overflow).
 */
export function majorityFlagProbability(p: number, k: number): number {
  if (!Number.isInteger(k) || k < 1 || k % 2 === 0) {
    throw new RangeError(`k must be a positive ODD integer (got ${k}) so majority vote has no ties`);
  }
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const threshold = (k + 1) / 2; // odd k → need ≥ (k+1)/2 ones for a majority
  // pmf(0) = (1-p)^k, then pmf(j+1) = pmf(j) · (k-j)/(j+1) · p/(1-p).
  let pmf = Math.pow(1 - p, k);
  const odds = p / (1 - p);
  let tail = 0;
  for (let j = 0; j <= k; j++) {
    if (j >= threshold) tail += pmf;
    pmf *= ((k - j) / (j + 1)) * odds;
  }
  return Math.min(1, Math.max(0, tail));
}

/** Per-row probability that a k-sample majority vote MATCHES the gold label. */
export function rowMatchProbability(row: JudgeRow, k: number): number {
  const flag = majorityFlagProbability(row.flagProb, k);
  return row.goldFlag ? flag : 1 - flag;
}

export interface SaturationPoint {
  /** The (odd) number of judge samples majority-voted. */
  k: number;
  /** Expected accuracy vs gold of the k-sample majority vote over the FIXED set. */
  accuracy: number;
  /** Improvement over the previous k in the swept grid (0 at the first point). */
  gain: number;
}

export interface SaturationCurve {
  n: number;
  /** The swept odd-k grid. */
  ks: number[];
  points: SaturationPoint[];
  /** The k=∞ consensus accuracy: fraction of rows whose consensus (sign of flagProb−1/2) matches gold,
   *  with coin-flip rows (|flagProb−1/2| < eps) contributing exactly 1/2. The curve saturates HERE. */
  asymptote: number;
  /** Fraction of rows that are coin flips for the judge — the irreducible floor sampling cannot remove. */
  irreducibleAmbiguity: number;
  /** Smallest k in the grid within `tol` of the asymptote — the practical "stop sampling" point (null if
   *  the grid never gets there). */
  saturationK: number | null;
}

/**
 * Build the sample-k saturation curve over a FIXED set of judge rows. `ks` must be positive ODD integers
 * (default 1,3,5,…,21). Pure: no model spend.
 */
export function saturationCurve(
  rows: readonly JudgeRow[],
  ks: readonly number[] = [1, 3, 5, 7, 9, 11, 15, 21, 31, 51, 75, 101],
  opts: { eps?: number; tol?: number } = {},
): SaturationCurve {
  const eps = opts.eps ?? AMBIGUITY_EPS;
  const tol = opts.tol ?? 0.005;
  const n = rows.length;

  const consensusAcc = (row: JudgeRow): number => {
    if (Math.abs(row.flagProb - 0.5) < eps) return 0.5; // coin flip — irreducible
    const consensusFlag = row.flagProb > 0.5;
    return consensusFlag === row.goldFlag ? 1 : 0;
  };
  const asymptote = n === 0 ? 0 : rows.reduce((s, r) => s + consensusAcc(r), 0) / n;
  const irreducibleAmbiguity = n === 0 ? 0 : rows.filter((r) => Math.abs(r.flagProb - 0.5) < eps).length / n;

  const sortedKs = [...ks].sort((a, b) => a - b);
  const points: SaturationPoint[] = [];
  let prev = 0;
  let saturationK: number | null = null;
  for (const [i, k] of sortedKs.entries()) {
    const accuracy = n === 0 ? 0 : rows.reduce((s, r) => s + rowMatchProbability(r, k), 0) / n;
    points.push({ k, accuracy, gain: i === 0 ? 0 : accuracy - prev });
    if (saturationK === null && Math.abs(accuracy - asymptote) <= tol) saturationK = k;
    prev = accuracy;
  }

  return { n, ks: sortedKs, points, asymptote, irreducibleAmbiguity, saturationK };
}

/**
 * A DOCUMENTED synthetic stochastic-judge instrument for the KEYLESS path — emphatically NOT a
 * measurement of any real judge. It maps each gold row to a flip-probability so the saturation MATH can
 * be exercised with zero model spend:
 *   - a fraction `ambiguousFraction` of rows are coin flips (flagProb = 1/2) — the irreducible floor;
 *   - the rest lean the RIGHT way with margin `margin` (gold-CM rows → 1/2+margin, gold-ok rows →
 *     1/2−margin), so the consensus is correct and the curve saturates to (1 − ambiguityErr).
 * Deterministic given the row order; with a key, replace this with empirical per-row flip-frequencies.
 */
export function syntheticJudgeInstrument(
  goldFlags: readonly boolean[],
  opts: { margin?: number; ambiguousFraction?: number } = {},
): JudgeRow[] {
  const margin = opts.margin ?? 0.2;
  const ambiguousFraction = opts.ambiguousFraction ?? 0.2;
  const everyNth = ambiguousFraction <= 0 ? Infinity : Math.max(2, Math.round(1 / ambiguousFraction));
  return goldFlags.map((goldFlag, i) => {
    const ambiguous = everyNth !== Infinity && i % everyNth === 0;
    const flagProb = ambiguous ? 0.5 : goldFlag ? 0.5 + margin : 0.5 - margin;
    return { flagProb, goldFlag };
  });
}
