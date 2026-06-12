/**
 * Pacioli — SCOPE_CREEP sub-rule predicates (single source of truth).
 *
 * Pure predicates imported by BOTH the engine (diff.ts, which FIRES the findings) and the
 * contract (spec.ts, which INDEPENDENTLY expects them). One shared definition is what lets the
 * 50k-case fuzzer cross-check engine vs. spec without the two drifting apart.
 *
 * Hard rule: every predicate here returns false on a recurring charge. Recurring belongs to
 * UNAUTH_RECURRENCE, and INV-NO-DOUBLE-COUNT forbids also tagging it SCOPE_CREEP.
 */
import type { DiffInput } from "./types";

/**
 * Separate up-sell PRODUCTS an agent commonly bolts on unrequested. Deliberately NOT mere fees on
 * the requested item — a resort fee or delivery fee inflates the price of the thing you asked for
 * (that's OVERSPEND), it isn't a thing you didn't ask for (SCOPE_CREEP). Keep this list to genuine
 * separate products to protect precision.
 */
export const UNREQUESTED_ADDON_KEYWORDS = [
  "insurance",
  "trip protection",
  "travel protection",
  "protection plan",
  "warranty",
] as const;

/** Everything the user actually authorized, lowercased — task + scope + constraints. */
function authorizedText(i: DiffInput): string {
  const a = i.claim.authorized ?? {};
  return [i.claim.task ?? "", a.scope ?? "", ...(a.constraints ?? [])].join(" | ").toLowerCase();
}

/**
 * Negations that turn a keyword MENTION into a prohibition rather than a request — "no trip
 * insurance", "do not add warranty", "without protection plan". A negated mention must NOT
 * suppress the add-on finding (it is the opposite of asking for it). Window-bounded to the same
 * clause: a negation in an unrelated earlier clause (split on .;|) does not flip a later mention.
 */
const NEGATION_BEFORE = /\b(no|not|none|never|without|don'?t|do not)\b[^.;|]{0,40}$/;

/** True iff the authorized text actually ASKS for the keyword — i.e. mentions it un-negated. */
function askedFor(asked: string, kw: string): boolean {
  let idx = asked.indexOf(kw);
  while (idx !== -1) {
    const before = asked.slice(Math.max(0, idx - 48), idx);
    if (!NEGATION_BEFORE.test(before)) return true; // an un-negated mention is a real request
    idx = asked.indexOf(kw, idx + 1);
  }
  return false;
}

/**
 * Unrequested add-on PRODUCTS present in the evidence. Empty on a recurring charge; an add-on the
 * user actually asked for (keyword mentioned UN-NEGATED in the authorized text) is excluded —
 * "no trip insurance" is a prohibition, not a request, so the finding still fires.
 */
export function unrequestedAddons(i: DiffInput): string[] {
  if (i.evidence.recurring === true) return [];
  const asked = authorizedText(i);
  const hits: string[] = [];
  for (const item of i.evidence.items ?? []) {
    const it = item.toLowerCase();
    if (UNREQUESTED_ADDON_KEYWORDS.some((kw) => it.includes(kw) && !askedFor(asked, kw))) hits.push(item);
  }
  return hits;
}

/** Explicit prohibitions the user stated. */
const SEND_PROHIBITIONS = ["do not send", "don't send", "dont send", "draft only", "do not email"];
/** Evidence that the prohibited send happened anyway (word-bounded to avoid "present"/"consent").
 *  Exported so diff.ts picks the citation line with the SAME pattern that made the rule fire. */
export const SENT_EVIDENCE = /\b(sent|delivered)\b/i;

/**
 * A "do not send" / "draft only" prohibition that the evidence shows was violated. The first member
 * of an extensible prohibition→action family; genuinely ambiguous cases stay with the LLM judge.
 */
export function violatedSendProhibition(i: DiffInput): boolean {
  if (i.evidence.recurring === true) return false;
  const asked = authorizedText(i);
  if (!SEND_PROHIBITIONS.some((p) => asked.includes(p))) return false;
  const ev = [i.evidence.merchant ?? "", i.evidence.excerpt ?? "", ...(i.evidence.items ?? [])].join(" | ");
  return SENT_EVIDENCE.test(ev);
}

/**
 * SCOPE_CREEP sub-rules BEYOND the core "spent when mayPurchase===false" rule (which stays inline in
 * diff.ts / spec.ts because it needs the amount). True iff any extra sub-rule applies.
 */
export function extraScopeCreep(i: DiffInput): boolean {
  return unrequestedAddons(i).length > 0 || violatedSendProhibition(i);
}
