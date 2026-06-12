/**
 * Pacioli — line-item reconciliation (the literal "double-entry" check).
 *
 * When evidence is itemized with prices, the stated total must equal the sum of the line items within
 * tolerance — an arithmetic, fully deterministic property. A mismatch is a TOTAL_MISMATCH: a hidden
 * fee, a miscount, or a padded total. Pure; a parallel deterministic surface kept OUT of the core
 * 4-class engine (to avoid rippling its invariants) — exactly the kind of exact check rules-first owns.
 */
export interface LineItem {
  label: string;
  amountUsd: number;
}

export interface LineItemFinding {
  type: "TOTAL_MISMATCH";
  sumUsd: number;
  statedUsd: number;
  /** stated − sum (positive = the stated total is padded above the itemization). */
  deltaUsd: number;
  severity: "low" | "medium" | "high";
  note: string;
}

const PENNY = 0.01;

/** Reconcile an itemized receipt against its stated total. Returns null if it balances within tolerance. */
export function reconcileLineItems(
  items: LineItem[],
  statedTotalUsd: number,
  toleranceUsd = PENNY,
): LineItemFinding | null {
  const sum = Number(items.reduce((s, i) => s + i.amountUsd, 0).toFixed(2));
  const delta = Number((statedTotalUsd - sum).toFixed(2));
  if (Math.abs(delta) <= toleranceUsd) return null;

  const mag = Math.abs(delta);
  const ref = Math.max(Math.abs(statedTotalUsd), 1);
  const severity = mag > ref * 0.15 ? "high" : mag > ref * 0.05 ? "medium" : "low";
  return {
    type: "TOTAL_MISMATCH",
    sumUsd: sum,
    statedUsd: statedTotalUsd,
    deltaUsd: delta,
    severity,
    note: `itemized total $${sum.toFixed(2)} ≠ stated $${statedTotalUsd.toFixed(2)} (off by $${delta.toFixed(2)})`,
  };
}
