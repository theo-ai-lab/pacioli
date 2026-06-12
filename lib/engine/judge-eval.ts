/**
 * Pacioli — judge evaluation harness.
 *
 * An LLM judge is a measurement instrument, so it must be measured before it's trusted. This is the
 * code that turns the gated CLAIM_MISMATCH judge into a CALIBRATED instrument:
 *   - calibrate() over a labeled set → TPR/FPR, precision/recall/F1, accuracy, Cohen's κ.
 *   - wilsonInterval()/rateWithCI() → a rate with a 95% confidence interval ("37–44%"), not a point.
 *   - positionalBiasRate() → an evaluator-of-the-evaluator probe: does swapping order flip the verdict?
 *
 * Pure and model-agnostic: the live judge is injected, so the harness is unit-tested now (mock judge)
 * and runs against a real key + human labels later. See the Methods page + SPEC.md.
 */

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface CalibrationReport {
  n: number;
  confusion: Confusion;
  /** true-positive rate (recall / sensitivity) */
  tpr: number | null;
  /** false-positive rate */
  fpr: number | null;
  precision: number | null;
  f1: number | null;
  accuracy: number;
  /** chance-corrected agreement with the human labels */
  cohensKappa: number;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/** Calibrate a binary judge against gold labels (here: "is this a CLAIM_MISMATCH?"). */
export function calibrate(samples: Array<{ gold: boolean; judged: boolean }>): CalibrationReport {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const s of samples) {
    if (s.gold && s.judged) c.tp++;
    else if (!s.gold && s.judged) c.fp++;
    else if (!s.gold && !s.judged) c.tn++;
    else c.fn++;
  }
  const n = samples.length;
  const tpr = ratio(c.tp, c.tp + c.fn);
  const fpr = ratio(c.fp, c.fp + c.tn);
  const precision = ratio(c.tp, c.tp + c.fp);
  const f1 = precision != null && tpr != null && precision + tpr > 0 ? (2 * precision * tpr) / (precision + tpr) : null;
  const accuracy = n === 0 ? 0 : (c.tp + c.tn) / n;

  // Cohen's kappa: chance-corrected agreement
  const po = accuracy;
  const pe =
    n === 0
      ? 0
      : ((c.tp + c.fn) * (c.tp + c.fp) + (c.fp + c.tn) * (c.fn + c.tn)) / (n * n);
  const cohensKappa = pe === 1 ? 1 : (po - pe) / (1 - pe);

  return { n, confusion: c, tpr, fpr, precision, f1, accuracy, cohensKappa };
}

/** Wilson score interval for a binomial proportion — the right CI for small/edge samples. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** A rate expressed as a confidence interval, e.g. "37–44%". The honest shape of the headline rate. */
export function rateWithCI(successes: number, n: number): string {
  if (n === 0) return "—";
  const { low, high } = wilsonInterval(successes, n);
  return `${Math.round(low * 100)}–${Math.round(high * 100)}%`;
}

/**
 * Evaluator-of-the-evaluator: positional-bias probe. Runs each case and an order-swapped variant
 * through the (injected) judge; a non-trivial flip rate means the verdict depends on presentation,
 * not the evidence — a known way LLM judges degrade below random. Returns the flip rate in [0,1].
 */
export async function positionalBiasRate<T>(
  cases: T[],
  judge: (c: T) => Promise<boolean>,
  swap: (c: T) => T,
): Promise<number> {
  if (cases.length === 0) return 0;
  let flips = 0;
  for (const c of cases) {
    const [a, b] = [await judge(c), await judge(swap(c))];
    if (a !== b) flips++;
  }
  return flips / cases.length;
}
