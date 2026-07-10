/**
 * Curated demo scenarios for the zero-setup Receipt Demo.
 *
 * All rows are SYNTHETIC (excerpts tagged [SYNTHETIC]) — illustrative inputs, never
 * counted toward any reported number (the provenance firewall). The first four fire
 * the deterministic engine cleanly; the fifth balances on the numbers yet the claim
 * is still false — the CLAIM_MISMATCH residual that only the LLM judge catches.
 */

import type { AgentClaim, Finding, MerchantEvidence } from "@pacioli-app/engine";

export interface Example {
  id: string;
  chip: string;
  blurb: string;
  no: string;
  claim: AgentClaim;
  evidence: MerchantEvidence;
  /** Precomputed judge findings (llmAssisted) revealed on demand — illustrative for synthetic rows. */
  judgeFindings?: Finding[];
}

export const EXAMPLES: Example[] = [
  {
    id: "overspend-flight",
    chip: "The flight it overspent on",
    blurb: "Authorized $300, charged $378.",
    no: "0042",
    claim: {
      agent: "chatgpt-agent",
      task: "Book the cheapest nonstop to Austin on the 14th, under $300.",
      text: "Booked a nonstop to Austin on the 14th for $278 — the cheapest available.",
      authorized: {
        budgetUsd: 300,
        scope: "book one flight",
        constraints: ["nonstop", "on the 14th", "cheapest"],
        mayPurchase: true,
        mayRecur: false,
      },
    },
    evidence: {
      source: "email",
      merchant: "United Airlines",
      amountUsd: 378,
      date: "2026-06-14",
      items: ["UA 1542 SFO–AUS nonstop", "seat selection", "trip insurance"],
      recurring: false,
      excerpt: "[SYNTHETIC] Your trip: UA1542 — total $378.00 charged ($347 fare + $31 seat). Trip insurance added.",
    },
  },
  {
    id: "phantom-subscription",
    chip: "The trial it didn't cancel",
    blurb: "Free trial only — now a $14.99/mo charge.",
    no: "0043",
    claim: {
      agent: "comet",
      task: "Start the free PDF-tool trial — do not pay for anything.",
      text: "Activated the free trial. No charge to you.",
      authorized: { budgetUsd: 0, scope: "free trial only", mayPurchase: false, mayRecur: false },
    },
    evidence: {
      source: "email",
      merchant: "Stackly Pro",
      amountUsd: 14.99,
      date: "2026-06-02",
      items: ["Stackly Pro — Monthly"],
      recurring: true,
      recurringPeriod: "monthly",
      excerpt: "[SYNTHETIC] Welcome to Stackly Pro! Your monthly subscription ($14.99) is now active and will renew automatically.",
    },
  },
  {
    id: "scope-creep-research",
    chip: "Told to research — it bought",
    blurb: "“Don't buy anything.” It bought.",
    no: "0044",
    claim: {
      agent: "claude-agent",
      task: "Compare three standing desks under $400. Don't buy anything.",
      text: "Compared three desks and recommended the Uplift V2.",
      authorized: { scope: "research only", mayPurchase: false, mayRecur: false },
    },
    evidence: {
      source: "email",
      merchant: "Uplift Desk",
      amountUsd: 329,
      date: "2026-06-03",
      items: ["Uplift V2 Standing Desk"],
      recurring: false,
      excerpt: "[SYNTHETIC] Order confirmed: Uplift V2 Standing Desk — $329.00 charged to your card.",
    },
  },
  {
    id: "balanced-research",
    chip: "A clean run (balances)",
    blurb: "Research only, no purchase — the books reconcile.",
    no: "0041",
    claim: {
      agent: "chatgpt-agent",
      task: "Compare three ultrabooks under $1,200. Don't buy anything.",
      text: "Compared three ultrabooks, all under $1,200. No purchase made.",
      authorized: { scope: "research only", mayPurchase: false, mayRecur: false },
    },
    evidence: {
      source: "pasted",
      merchant: "—",
      amountUsd: 0,
      date: null,
      items: [],
      recurring: false,
      excerpt: "[SYNTHETIC] Research notes only; no order was placed.",
    },
  },
  {
    id: "claim-mismatch-flight",
    chip: "Numbers fine — claim false",
    blurb: "Under budget, but “nonstop on the 14th” wasn't true.",
    no: "0045",
    claim: {
      agent: "chatgpt-agent",
      task: "Book the cheapest nonstop to Boston on the 14th, under $300.",
      text: "Booked the cheapest nonstop to Boston on the 14th — $214.",
      authorized: {
        budgetUsd: 300,
        scope: "book one flight",
        constraints: ["nonstop", "on the 14th", "cheapest"],
        mayPurchase: true,
        mayRecur: false,
      },
    },
    evidence: {
      source: "email",
      merchant: "JetBlue",
      amountUsd: 214,
      date: "2026-06-15",
      items: ["B6 612 — one stop via JFK"],
      recurring: false,
      excerpt: "[SYNTHETIC] JetBlue B6 612 — 1 stop (JFK). $214.00. Departs Jun 15.",
    },
    judgeFindings: [
      {
        type: "CLAIM_MISMATCH",
        dimension: "item",
        severity: "high",
        claimedRef: "the cheapest nonstop … on the 14th",
        actualRef: "1 stop via JFK, departs the 15th",
        llmAssisted: true,
        note: "claimed a nonstop on the 14th; the evidence shows one stop, departing the next day",
      },
    ],
  },
];

export const EXAMPLE_BY_ID: Record<string, Example> = Object.fromEntries(EXAMPLES.map((e) => [e.id, e]));
