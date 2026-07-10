/**
 * Pacioli — abductive diagnosis.
 *
 * Detection says *that* the books don't balance. Diagnosis asks *why*. For each finding,
 * this produces a deterministic, ranked set of plausible root causes — grounded in the
 * patterns seen across the documented incidents — moving Pacioli from a checker toward a
 * black-box recorder. Pure and deterministic: no model, no network.
 */

import type { DiffInput, Finding } from "./types";

export type Likelihood = "high" | "medium" | "low";

export interface Hypothesis {
  cause: string;
  likelihood: Likelihood;
  rationale: string;
}

const ADDON_RE = /insurance|seat|fee|protection|warranty|priority|bag|gratuity|service charge/i;
const RANK: Record<Likelihood, number> = { high: 0, medium: 1, low: 2 };
const rank = (h: Hypothesis[]): Hypothesis[] => [...h].sort((a, b) => RANK[a.likelihood] - RANK[b.likelihood]);

/** Ranked plausible root causes for a single finding, given the case it came from. */
export function hypothesize(finding: Finding, input: DiffInput): Hypothesis[] {
  const ev = input.evidence;
  const addOns = ev.items.filter((i) => ADDON_RE.test(i));
  const hasAddOns = addOns.length > 0;

  switch (finding.type) {
    case "OVERSPEND":
      return rank([
        {
          cause: "Undisclosed add-ons or fees",
          likelihood: hasAddOns ? "high" : "medium",
          rationale: hasAddOns
            ? `the evidence itemizes chargeable extras (${addOns.join(", ")}) absent from the quote`
            : "extras added at checkout are the most common cause of post-quote price growth",
        },
        { cause: "Taxes or surcharges excluded from the quote", likelihood: "medium", rationale: "quoted prices frequently omit tax until checkout" },
        { cause: "Dynamic or surge pricing between quote and purchase", likelihood: "low", rationale: "the fare can move before the agent completes checkout" },
        { cause: "Currency conversion", likelihood: "low", rationale: "cross-currency settlement can inflate the charged amount" },
        { cause: "Agent error or misreport", likelihood: "low", rationale: "the price the agent stated may simply be wrong" },
      ]);

    case "UNAUTH_RECURRENCE":
      return rank([
        { cause: "Free trial that auto-converts to a paid plan", likelihood: "high", rationale: "the classic dark pattern: a 'free trial' silently rolls into a recurring charge" },
        { cause: "Subscription opt-in defaulted on", likelihood: "medium", rationale: "the merchant pre-checks recurring billing and the agent didn't opt out" },
        { cause: "Agent misread 'trial' as 'subscribe'", likelihood: "medium", rationale: "the agent may have authorized recurrence it wasn't asked to" },
        { cause: "Recurring charge bundled with a one-time purchase", likelihood: "low", rationale: "a membership tied to the item, not separately authorized" },
      ]);

    case "SCOPE_CREEP":
      return rank([
        { cause: "Agent exceeded its mandate", likelihood: "high", rationale: "a purchase occurred under a research-only / no-purchase authorization" },
        { cause: "Ambiguous instruction the agent resolved by buying", likelihood: "medium", rationale: "'find me the best one' read as 'buy the best one'" },
        { cause: "Agent 'helpfully' completed the transaction", likelihood: "medium", rationale: "over-eager task completion past the stated boundary" },
      ]);

    case "CLAIM_MISMATCH":
      return rank([
        { cause: "Agent misinterpreted the constraint", likelihood: "high", rationale: "'nonstop' / 'cheapest' / 'by the 14th' read loosely against the booking" },
        { cause: "The booking changed after the agent acted", likelihood: "medium", rationale: "an itinerary or item can be altered by the merchant post-confirmation" },
        { cause: "Agent overstated or fabricated the outcome", likelihood: "medium", rationale: "the claim asserts something the evidence does not support" },
        { cause: "Stale or wrong data when the agent reported", likelihood: "low", rationale: "the agent summarized from an out-of-date view" },
      ]);
  }
}

/** The single best diagnosis for a verdict (the highest-severity finding's top hypothesis). */
export function topHypothesis(findings: Finding[], input: DiffInput): Hypothesis | null {
  const order = ["critical", "high", "medium", "low"];
  const worst = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))[0];
  if (!worst) return null;
  return hypothesize(worst, input)[0] ?? null;
}
