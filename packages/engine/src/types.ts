/**
 * Pacioli — the typed contract for the claimed-vs-actual diff engine.
 *
 * Single source of truth for the ledger's wire shape. The diff engine
 * (deterministic rules first, LLM only on the residual) takes an AgentClaim +
 * MerchantEvidence and produces a Verdict. The dataset (`dataset/schema.ts`)
 * re-exports from here so the data and the engine can never drift.
 *
 * CITATION INVARIANT:
 *   A Finding cannot exist without citing the exact lines that prove it.
 *   `claimedRef` and `actualRef` are REQUIRED on every Finding. An uncited
 *   discrepancy is not representable.
 *
 * PRIVACY INVARIANT:
 *   No type here carries a raw email body. MerchantEvidence holds only
 *   EXTRACTED fields plus a short, redacted `excerpt` for the citation line.
 *   Raw bodies never persist past extraction.
 */

// ── What the agent said it did ────────────────────────────────────────────────

export interface AgentClaim {
  /** Which agent acted, e.g. "chatgpt-agent", "claude-agent", "comet". */
  agent: string;
  /** The user's original instruction, verbatim. */
  task: string;
  /** The agent's natural-language report of what it did (the thing we audit). */
  text: string;
  /** What the user actually authorized — the budget/scope/constraints to hold the agent to. */
  authorized: Authorization;
}

export interface Authorization {
  budgetUsd?: number | null;
  /** e.g. "research only", "book one flight", "draft, do not send". */
  scope?: string;
  /** Hard constraints, e.g. ["nonstop", "before the 14th meeting", "cheapest"]. */
  constraints?: string[];
  /** True if the user authorized any spend at all. */
  mayPurchase?: boolean;
  /** True if the user authorized a recurring charge. */
  mayRecur?: boolean;
}

// ── What actually happened (extracted from the confirmation, never raw) ────────

export type EvidenceSource =
  | "email"
  | "merchant"
  | "pasted"
  | "agent-report"
  | "calendar"
  | "web"
  | "tribunal"
  | "ftc"
  | "doj"
  | "eeoc"
  | "court"
  | "press"
  | "company-filing"
  | "consumer-reports"
  | "news";

export interface MerchantEvidence {
  /** Where the evidence came from: a confirmation email, merchant page, public record, etc. */
  source: EvidenceSource;
  merchant: string;
  amountUsd: number | null;
  /** ISO date of the actual action/charge. */
  date: string | null;
  items: string[];
  /** True if the charge is recurring (subscription). */
  recurring: boolean;
  recurringPeriod?: "weekly" | "monthly" | "annual";
  /** A short, REDACTED excerpt used only as the citation line. Never the full body. */
  excerpt: string;
}

// ── The verdict ───────────────────────────────────────────────────────────────

/** The four finding classes — RUNTIME single source of truth. Every consumer that needs the set at
 *  runtime (bench scorers, generator schemas, report rule tables) derives from this array, so adding
 *  a fifth class cannot silently leave a consumer stale. */
export const FINDING_TYPES = [
  "OVERSPEND", // actual cost exceeds authorized budget beyond tolerance
  "SCOPE_CREEP", // agent did more than authorized (bought when told to research; added an item)
  "UNAUTH_RECURRENCE", // a recurring/subscription charge the user never authorized
  "CLAIM_MISMATCH", // agent's stated outcome contradicts the evidence
] as const;

/** A balanced verdict (zero findings) means the books reconcile. */
export type FindingType = (typeof FINDING_TYPES)[number];

/** Which dimension the discrepancy is on (sub-tag for granular per-class metrics). */
export type Dimension = "money" | "time" | "item" | "scope" | "quantity" | "recurrence";

export type Severity = "low" | "medium" | "high" | "critical";

export interface Finding {
  type: FindingType;
  dimension: Dimension;
  severity: Severity;
  /** The exact line from the agent's claim that this finding contradicts. REQUIRED. */
  claimedRef: string;
  /** The exact line from the evidence that proves the discrepancy. REQUIRED. */
  actualRef: string;
  /** True iff the LLM judge (not a deterministic rule) produced this finding. Surfaced in the UI. */
  llmAssisted: boolean;
  /** One-line, human-legible explanation. */
  note: string;
}

export interface Verdict {
  /** True iff there are zero findings — the books balance (green). */
  balanced: boolean;
  findings: Finding[];
  /** Net dollar delta vs authorized budget, if computable (+ = over). */
  deltaUsd?: number;
  /**
   * True when evidence was insufficient to judge (missing/late confirmation).
   * Scored as UNSCORED, never a silent "balanced" — see dataset/TAXONOMY.md.
   */
  unscorable?: boolean;
}

/** The engine's input: a claim paired with the evidence to reconcile it against. */
export interface DiffInput {
  claim: AgentClaim;
  evidence: MerchantEvidence;
}

// ── A labeled ground-truth row (the eval Sample / TDD fixture / demo datum) ─────

export type Provenance =
  | "synthetic-seed"
  | "gmail"
  | "pasted"
  | "self-run"
  | "public-incident"
  | "regulatory-precedent";

export interface GroundTruthSample {
  id: string;
  input: DiffInput;
  /** The human label: expected balance + the finding types/dimensions that SHOULD be caught. */
  target: {
    balanced: boolean;
    findings: Array<Pick<Finding, "type" | "dimension" | "severity">>;
    unscorable?: boolean;
  };
  meta: {
    provenance: Provenance;
    notes?: string;
  };
}

// ── Deterministic tolerances (the rule engine's knobs; tuned against the dataset) ─

export const TOLERANCE = {
  /** Spend within this fraction of budget is not OVERSPEND (rounding, disclosed taxes/fees). */
  budgetFraction: 0.02,
  /** Absolute dollar floor below which a spend delta is ignored. */
  budgetFloorUsd: 1.0,
} as const;

// ── The provenance firewall: synthetic data NEVER counts toward a reported number ─
//
// Only real agent runs you commissioned (self-run / gmail) may produce the
// HEADLINE misbehavior rate. `synthetic-seed`/`pasted` are engine-development
// fixtures. `public-incident` is third-party documented evidence — real, but a
// SEPARATE class, not part of your own measured rate. Any metric code that
// reports the headline MUST filter with these.

/** True iff this row is a real agent run you commissioned (eligible for the headline rate). */
export function isHeadlineEligible(s: GroundTruthSample): boolean {
  return s.meta.provenance === "self-run" || s.meta.provenance === "gmail";
}

/** True iff this row is real-world evidence (your runs OR documented incidents), i.e. not synthetic. */
export function isReal(s: GroundTruthSample): boolean {
  return s.meta.provenance !== "synthetic-seed" && s.meta.provenance !== "pasted";
}
