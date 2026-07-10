/**
 * Pacioli MCP — the reconcile tool's logic (transport-free, so it's unit-testable).
 *
 * Maps an agent-friendly flat argument set onto the engine's DiffInput, runs the deterministic
 * reconciliation, and returns a structured receipt + a tamper-evident content hash + the top
 * abductive cause. Pure + deterministic; no key, no network. (Relative imports: this runs under
 * tsx, which does not resolve the app's `@/` tsconfig alias.)
 */

import { buildReceipt } from "@pacioli-app/engine";
import type { DiffInput } from "@pacioli-app/engine";

export interface ReconcileArgs {
  agent: string;
  task: string;
  claim: string;
  budgetUsd?: number | null;
  mayPurchase?: boolean;
  mayRecur?: boolean;
  constraints?: string[];
  merchant: string;
  amountUsd?: number | null;
  recurring?: boolean;
  recurringPeriod?: "weekly" | "monthly" | "annual";
  items?: string[];
  date?: string | null;
  excerpt: string;
}

export interface ReconcileResult {
  verdict: "BALANCED" | "OUT_OF_BALANCE";
  balanced: boolean;
  findings: Array<{
    type: string;
    dimension: string;
    severity: string;
    claimedRef: string;
    actualRef: string;
    note: string;
    llmAssisted: boolean;
  }>;
  deltaUsd?: number;
  likelyCause: string | null;
  receiptId: string;
  receiptHash: string;
  note: string;
}

export function toDiffInput(a: ReconcileArgs): DiffInput {
  return {
    claim: {
      agent: a.agent,
      task: a.task,
      text: a.claim,
      authorized: {
        budgetUsd: a.budgetUsd ?? undefined,
        constraints: a.constraints,
        mayPurchase: a.mayPurchase,
        mayRecur: a.mayRecur,
      },
    },
    evidence: {
      source: "pasted",
      merchant: a.merchant,
      amountUsd: a.amountUsd ?? null,
      date: a.date ?? null,
      items: a.items ?? [],
      recurring: a.recurring ?? false,
      recurringPeriod: a.recurringPeriod,
      excerpt: a.excerpt,
    },
  };
}

export async function reconcile(a: ReconcileArgs): Promise<ReconcileResult> {
  const input = toDiffInput(a);
  const { verdict: v, receiptId, receiptHash: hash, likelyCause } = await buildReceipt(input);
  const n = v.findings.length;
  return {
    verdict: v.balanced ? "BALANCED" : "OUT_OF_BALANCE",
    balanced: v.balanced,
    findings: v.findings.map((f) => ({
      type: f.type,
      dimension: f.dimension,
      severity: f.severity,
      claimedRef: f.claimedRef,
      actualRef: f.actualRef,
      note: f.note,
      llmAssisted: f.llmAssisted,
    })),
    deltaUsd: v.deltaUsd,
    likelyCause,
    receiptId,
    receiptHash: hash,
    note: v.balanced
      ? "Balances on the deterministic rules (overspend / unauthorized recurrence / scope creep). Fuzzy claim-vs-evidence wording mismatches are NOT checked here — they are the abstained LLM-judge residual."
      : `Out of balance: ${n} discrepanc${n === 1 ? "y" : "ies"}, by the deterministic rules only. A CLAIM_MISMATCH on wording/constraint is abstained by design and needs the gated LLM judge.`,
  };
}
