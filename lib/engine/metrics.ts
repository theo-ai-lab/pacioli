/**
 * Pacioli — per-class evaluation metrics.
 *
 * Reports PER-CLASS precision/recall (never one flattering accuracy number).
 * This module is the single scorer shared by the dev CLI (`npm run eval`), the
 * public Methods page, and the prediction file fed to the Inspect AI harness —
 * so every reported number traces to the same code path.
 *
 * The provenance firewall is enforced by the CALLER (it chooses which rows to
 * pass in); see packages/engine/src/types.ts `isHeadlineEligible` / `isReal`.
 */

import { diff } from "@pacioli-app/engine";
import type { FindingType, GroundTruthSample } from "@pacioli-app/engine";

export const FINDING_TYPES: FindingType[] = [
  "OVERSPEND",
  "SCOPE_CREEP",
  "UNAUTH_RECURRENCE",
  "CLAIM_MISMATCH",
];

export interface ClassMetric {
  type: FindingType;
  tp: number;
  fp: number;
  fn: number;
  /** precision = tp / (tp + fp); null when the engine never predicts this class. */
  precision: number | null;
  /** recall = tp / (tp + fn); null when the labeled set contains no positives. */
  recall: number | null;
  /** Labeled positives for this class (the eval's support / denominator context). */
  support: number;
}

export interface EvalReport {
  perClass: ClassMetric[];
  /** How often the engine's balanced/out-of-balance call matched the label. */
  balancedCorrect: number;
  balancedTotal: number;
  /** Total scorable rows (unscorable rows are excluded, never counted as correct). */
  n: number;
  /** Rows skipped because the label marks them unscorable (missing/late evidence). */
  unscored: number;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/**
 * Score the deterministic engine against a labeled set, per class.
 * A row may carry several findings; each (row, class) pair is one labeled instance.
 */
export function evaluate(rows: GroundTruthSample[]): EvalReport {
  const tally: Record<FindingType, { tp: number; fp: number; fn: number; support: number }> =
    Object.fromEntries(FINDING_TYPES.map((t) => [t, { tp: 0, fp: 0, fn: 0, support: 0 }])) as Record<
      FindingType,
      { tp: number; fp: number; fn: number; support: number }
    >;

  let balancedCorrect = 0;
  let n = 0;
  let unscored = 0;

  for (const row of rows) {
    if (row.target.unscorable) {
      unscored++;
      continue;
    }
    const predicted = diff(row.input);
    const labeled = new Set((row.target.findings ?? []).map((f) => f.type));
    const got = new Set(predicted.findings.map((f) => f.type));

    for (const t of FINDING_TYPES) {
      if (labeled.has(t)) tally[t].support++;
      if (labeled.has(t) && got.has(t)) tally[t].tp++;
      else if (got.has(t) && !labeled.has(t)) tally[t].fp++;
      else if (labeled.has(t) && !got.has(t)) tally[t].fn++;
    }

    n++;
    if (row.target.balanced === predicted.balanced) balancedCorrect++;
  }

  const perClass: ClassMetric[] = FINDING_TYPES.map((type) => {
    const { tp, fp, fn, support } = tally[type];
    return { type, tp, fp, fn, support, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  });

  return { perClass, balancedCorrect, balancedTotal: n, n, unscored };
}
