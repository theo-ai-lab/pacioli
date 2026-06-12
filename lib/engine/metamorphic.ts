/**
 * Pacioli — metamorphic properties.
 *
 * Unit tests check single outputs; the fuzzer checks the firing contract. Metamorphic testing checks
 * RELATIONS between runs — properties that must hold when an input is transformed, even without a full
 * oracle. These encode domain truths the rules must respect, and they're the strongest evidence (short
 * of a proof) that the engine is logically coherent, not merely passing examples.
 *
 *   MP-CHARGE-MONOTONE   — more money charged can never REMOVE an overspend.
 *   MP-BUDGET-MONOTONE   — raising the budget can never CREATE an overspend.
 *   MP-AUTH-MONOTONE     — granting authorization can only REMOVE findings, never add them.
 *   MP-DELTA-SIGN        — if OVERSPEND fired, the net delta is strictly positive.
 *   MP-ADDON-MONOTONE    — appending an unrequested add-on can only ADD findings, never remove one.
 *   MP-RECUR-DOMINANCE   — SCOPE_CREEP can never survive a charge becoming recurring (no double-count).
 *
 * Fuzzed over the same generator as lib/engine/fuzz.ts (`npm run fuzz` covers the firing contract).
 */

import { diff } from "./diff";
import { genInput, mulberry32 } from "./fuzz";
import type { DiffInput } from "./types";

const fires = (i: DiffInput, t: string): boolean => diff(i).findings.some((f) => f.type === t);
const types = (i: DiffInput): Set<string> => new Set(diff(i).findings.map((f) => f.type));

export interface MetamorphicViolation {
  property: string;
  detail: string;
}

/** Check every metamorphic relation for a single base input; returns the violations (empty = holds). */
export function metamorphicViolations(base: DiffInput): MetamorphicViolation[] {
  const out: MetamorphicViolation[] = [];
  const a = base.evidence.amountUsd;
  const b = base.claim.authorized.budgetUsd;

  // MP-CHARGE-MONOTONE: if OVERSPEND fires, charging MORE keeps it firing.
  if (typeof a === "number" && fires(base, "OVERSPEND")) {
    const more: DiffInput = { ...base, evidence: { ...base.evidence, amountUsd: a + 50 } };
    if (!fires(more, "OVERSPEND")) out.push({ property: "MP-CHARGE-MONOTONE", detail: "charging more removed OVERSPEND" });
  }

  // MP-BUDGET-MONOTONE: within the positive-budget regime, raising the budget never INTRODUCES an
  // OVERSPEND. (Raising a $0/negative budget to a positive one legitimately enables budget-checking,
  // so the relation is only meaningful once a real budget exists.)
  if (typeof b === "number" && b > 0) {
    const richer: DiffInput = { ...base, claim: { ...base.claim, authorized: { ...base.claim.authorized, budgetUsd: b + 1000 } } };
    if (fires(richer, "OVERSPEND") && !fires(base, "OVERSPEND"))
      out.push({ property: "MP-BUDGET-MONOTONE", detail: "raising the budget created an OVERSPEND" });
  }

  // MP-AUTH-MONOTONE: granting authorization can only REMOVE findings (subset), never add.
  const granted: DiffInput = {
    ...base,
    claim: { ...base.claim, authorized: { ...base.claim.authorized, mayPurchase: true, mayRecur: true } },
  };
  const before = types(base);
  const after = types(granted);
  for (const t of after) {
    if (!before.has(t)) out.push({ property: "MP-AUTH-MONOTONE", detail: `granting authorization added ${t}` });
  }

  // MP-DELTA-SIGN: an OVERSPEND implies a strictly positive net delta.
  const v = diff(base);
  if (fires(base, "OVERSPEND") && !(typeof v.deltaUsd === "number" && v.deltaUsd > 0))
    out.push({ property: "MP-DELTA-SIGN", detail: `OVERSPEND with deltaUsd=${v.deltaUsd}` });

  // MP-ADDON-MONOTONE: appending an unrequested add-on PRODUCT can only ADD findings (the new
  // SCOPE_CREEP), never remove one — more unasked-for stuff can't make the books balance.
  const withAddon: DiffInput = {
    ...base,
    evidence: { ...base.evidence, items: [...(base.evidence.items ?? []), "Trip insurance"] },
  };
  const addonTypes = types(withAddon);
  for (const t of types(base)) {
    if (!addonTypes.has(t)) out.push({ property: "MP-ADDON-MONOTONE", detail: `adding an add-on removed ${t}` });
  }

  // MP-RECUR-DOMINANCE: recurring is UNAUTH_RECURRENCE's territory — SCOPE_CREEP must never co-exist
  // with it. The relational form of INV-NO-DOUBLE-COUNT, checked across the recurring transform.
  const recurringVersion: DiffInput = { ...base, evidence: { ...base.evidence, recurring: true } };
  if (fires(recurringVersion, "SCOPE_CREEP"))
    out.push({ property: "MP-RECUR-DOMINANCE", detail: "SCOPE_CREEP survived making the charge recurring" });

  return out;
}

export interface MetamorphicResult {
  cases: number;
  seed: number;
  failures: Array<{ index: number; input: DiffInput; violations: MetamorphicViolation[] }>;
}

/** Fuzz the metamorphic relations over generated inputs. */
export function fuzzMetamorphic(cases = 10_000, seed = 1234): MetamorphicResult {
  const r = mulberry32(seed);
  const failures: MetamorphicResult["failures"] = [];
  for (let index = 0; index < cases; index++) {
    const input = genInput(r);
    const violations = metamorphicViolations(input);
    if (violations.length) failures.push({ index, input, violations });
  }
  return { cases, seed, failures };
}

export const METAMORPHIC_PROPERTIES = [
  "MP-CHARGE-MONOTONE",
  "MP-BUDGET-MONOTONE",
  "MP-AUTH-MONOTONE",
  "MP-DELTA-SIGN",
  "MP-ADDON-MONOTONE",
  "MP-RECUR-DOMINANCE",
] as const;
