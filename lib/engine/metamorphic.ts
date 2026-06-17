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
import {
  reconcileStream,
  streamFromDiffInput,
  type InfoClass,
  type ReconcileOptions,
  type VerdictClass,
} from "./prefix-reconcile";
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

// ── RECON-MR — monotone-safety of the prefix reconciler's EARLY COMMIT ──────────────────────────
//
//   RECON-MR — a verdict COMMITTED on a prefix MUST NOT flip to the opposite class once later
//              evidence arrives. A flip is a violation.
//
// This is a metamorphic relation OVER A STREAM rather than over a single transformed input: it
// explodes a base case into an arrival stream (lib/engine/prefix-reconcile.streamFromDiffInput),
// runs the reconciler, and checks that every prefix at/after the commit point keeps the committed
// class. Under the default "safe" policy (commit only when information-complete) this holds by
// construction — the fuzzer is the EMPIRICAL proof that the dominance check has no hole. Under the
// "stable-k" heuristic policy a flip CAN occur (that is the point of the negative test): the harness
// must be able to DETECT it, exactly like the broken-engine mock proves the MP-* relations bite.
//
// Fuzzed over the SAME generator as the MP-* relations (genInput / mulberry32), with the reveal
// order itself drawn from the generator so many arrival sequences are exercised.

export const RECON_MR = "RECON-MR" as const;

export interface ReconMrViolation {
  property: typeof RECON_MR;
  detail: string;
}

/**
 * Check RECON-MR for a single base case: build its arrival stream, reconcile, and report a
 * violation iff a committed class later flipped to the opposite class. `order`/`rng` choose the
 * reveal order; `reconcile` chooses the policy (default the monotone-safe one).
 */
export function reconMrViolations(
  base: DiffInput,
  opts: { rng?: () => number; order?: InfoClass[]; reconcile?: ReconcileOptions } = {},
): ReconMrViolation[] {
  const stream = streamFromDiffInput(base, { rng: opts.rng, order: opts.order });
  const run = reconcileStream(stream, opts.reconcile ?? { policy: "safe" });
  if (run.commitAt === null || run.heldToEnd) return [];
  const flipped = run.steps.slice(run.commitAt).find((s) => s.verdictClass !== run.committedClass);
  return [
    {
      property: RECON_MR,
      detail: `committed ${run.committedClass} at step ${run.commitAt}, then flipped to ${
        flipped?.verdictClass
      } at step ${flipped?.step}`,
    },
  ];
}

export interface ReconMrResult {
  cases: number;
  seed: number;
  policy: string;
  /** Cases where the policy committed at all. */
  commits: number;
  /** Cases where it committed STRICTLY before the stream ended (a genuine early commit). */
  earlyCommits: number;
  /** Cases that committed by information-completeness (the monotone-safe reason). */
  infoCompleteCommits: number;
  failures: Array<{ index: number; input: DiffInput; class: VerdictClass | null; violations: ReconMrViolation[] }>;
}

/** Fuzz RECON-MR over generated inputs (reveal order drawn from the same stream). */
export function fuzzReconMr(
  cases = 10_000,
  seed = 1234,
  reconcile: ReconcileOptions = { policy: "safe" },
): ReconMrResult {
  const r = mulberry32(seed);
  const failures: ReconMrResult["failures"] = [];
  let commits = 0;
  let earlyCommits = 0;
  let infoCompleteCommits = 0;

  for (let index = 0; index < cases; index++) {
    const input = genInput(r);
    const stream = streamFromDiffInput(input, { rng: r }); // shuffled reveal order from the generator
    const run = reconcileStream(stream, reconcile);

    if (run.commitAt !== null) commits++;
    if (run.committedEarly) earlyCommits++;
    if (run.committedReason === "information-complete") infoCompleteCommits++;

    if (run.commitAt !== null && !run.heldToEnd) {
      const flipped = run.steps.slice(run.commitAt).find((s) => s.verdictClass !== run.committedClass);
      failures.push({
        index,
        input,
        class: run.committedClass,
        violations: [
          {
            property: RECON_MR,
            detail: `committed ${run.committedClass} at step ${run.commitAt}, flipped to ${
              flipped?.verdictClass
            } at step ${flipped?.step}`,
          },
        ],
      });
    }
  }

  return { cases, seed, policy: reconcile.policy ?? "safe", commits, earlyCommits, infoCompleteCommits, failures };
}

/** The full named relation set, including the streaming RECON-MR relation. (METAMORPHIC_PROPERTIES is
 *  left unchanged so existing consumers/counters are untouched; this is the additive superset.) */
export const ALL_METAMORPHIC_PROPERTIES = [...METAMORPHIC_PROPERTIES, RECON_MR] as const;
