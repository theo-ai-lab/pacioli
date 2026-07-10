/**
 * Pacioli — the engine contract, as executable predicates (see SPEC.md).
 *
 * Each `expect*` recomputes a rule's firing condition INDEPENDENTLY of the engine, so
 * `checkInvariants` is a genuine cross-check (spec vs. implementation), not a tautology.
 * The fuzzer (lib/engine/fuzz.ts) runs this over tens of thousands of mutated inputs.
 */

import { TOLERANCE, type DiffInput, type FindingType, type Verdict } from "./types";
import { extraScopeCreep } from "./scope-rules";

export interface Violation {
  id: string;
  detail: string;
}

const has = (v: Verdict, t: FindingType): boolean => v.findings.some((f) => f.type === t);

// ── independently-stated firing conditions (the contract) ────────────────────────
export function expectOverspend(i: DiffInput): boolean {
  const b = i.claim.authorized?.budgetUsd;
  const a = i.evidence.amountUsd;
  if (typeof b !== "number" || b <= 0 || typeof a !== "number") return false;
  return a > b * (1 + TOLERANCE.budgetFraction) && a - b >= TOLERANCE.budgetFloorUsd;
}

export function expectUnauthRecurrence(i: DiffInput): boolean {
  return i.evidence.recurring === true && i.claim.authorized?.mayRecur !== true;
}

export function expectScopeCreep(i: DiffInput): boolean {
  const a = i.evidence.amountUsd;
  const spentUnauthorized =
    i.claim.authorized?.mayPurchase === false &&
    typeof a === "number" &&
    a > 0 &&
    i.evidence.recurring !== true;
  // (b) unrequested add-on product and (c) violated "do not send" prohibition live in the shared
  //     scope-rules module so this contract and the engine can never diverge.
  return spentUnauthorized || extraScopeCreep(i);
}

export function expectDelta(i: DiffInput): number | undefined {
  const a = i.evidence.amountUsd;
  if (typeof a !== "number") return undefined;
  const b = i.claim.authorized?.budgetUsd;
  return Number((a - (typeof b === "number" ? b : 0)).toFixed(2));
}

/** Returns the list of violated invariants (empty = the engine satisfies its contract for this input). */
export function checkInvariants(i: DiffInput, v: Verdict): Violation[] {
  const out: Violation[] = [];
  const fail = (id: string, detail: string) => out.push({ id, detail });

  if (has(v, "OVERSPEND") !== expectOverspend(i))
    fail("INV-OVERSPEND", `engine=${has(v, "OVERSPEND")} expected=${expectOverspend(i)}`);
  if (has(v, "UNAUTH_RECURRENCE") !== expectUnauthRecurrence(i))
    fail("INV-RECURRENCE", `engine=${has(v, "UNAUTH_RECURRENCE")} expected=${expectUnauthRecurrence(i)}`);
  if (has(v, "SCOPE_CREEP") !== expectScopeCreep(i))
    fail("INV-SCOPE", `engine=${has(v, "SCOPE_CREEP")} expected=${expectScopeCreep(i)}`);

  if (has(v, "CLAIM_MISMATCH")) fail("INV-ABSTAIN", "engine emitted CLAIM_MISMATCH (must abstain)");

  if (v.balanced !== (v.findings.length === 0))
    fail("INV-BALANCED", `balanced=${v.balanced} findings=${v.findings.length}`);

  for (const f of v.findings) {
    if (!f.claimedRef || !f.actualRef) fail("INV-CITATION", `${f.type} missing a citation ref`);
    if (!f.note) fail("INV-CITATION", `${f.type} missing a note`);
    if (f.llmAssisted !== false) fail("INV-DETERMINISTIC-FLAG", `${f.type} marked llmAssisted by the engine`);
  }

  const ed = expectDelta(i);
  if (v.deltaUsd !== ed) fail("INV-DELTA", `engine=${v.deltaUsd} expected=${ed}`);

  if (has(v, "SCOPE_CREEP") && i.evidence.recurring === true)
    fail("INV-NO-DOUBLE-COUNT", "SCOPE_CREEP fired on a recurring spend");

  return out;
}

/** The invariant IDs this module enforces, for docs/UI display. */
export const INVARIANTS = [
  "INV-OVERSPEND",
  "INV-RECURRENCE",
  "INV-SCOPE",
  "INV-ABSTAIN",
  "INV-BALANCED",
  "INV-CITATION",
  "INV-DETERMINISTIC-FLAG",
  "INV-DELTA",
  "INV-NO-DOUBLE-COUNT",
  "INV-DETERMINISM",
] as const;
