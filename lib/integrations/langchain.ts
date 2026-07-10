/**
 * Pacioli — agent-framework adapter (LangChain / Claude Agent SDK shaped).
 *
 * Dependency-FREE on purpose: typed to the minimal shape of a finished agent run, so it drops into a
 * LangChain callback (or any framework) WITHOUT importing it — map the agent's stated outcome + the
 * observed evidence into the engine and get a tamper-evident receipt, in the loop, mid-task.
 *
 * Usage from a LangChain callback handler:
 *   async handleChainEnd(outputs) {
 *     const receipt = await reconcileRun({ agent, task, output: outputs.text, authorized, evidence });
 *     if (!receipt.balanced) escalate(receipt);   // the agent's claim didn't reconcile with the evidence
 *   }
 */
import { buildReceipt } from "@pacioli-app/engine";
import type { Authorization, MerchantEvidence, Verdict } from "@pacioli-app/engine";

export interface AgentRun {
  agent: string;
  task: string;
  /** The agent's natural-language report of what it did (the claim under audit). */
  output: string;
  /** What the user authorized — the budget/scope/constraints to hold the agent to. */
  authorized: Authorization;
  /** Extracted, redacted evidence of what actually happened. */
  evidence: MerchantEvidence;
}

export interface AgentReceipt {
  balanced: boolean;
  verdict: Verdict;
  receiptId: string;
  receiptHash: string;
  likelyCause: string | null;
}

/** Reconcile one finished agent run into a Pacioli receipt. Framework-agnostic; deterministic; no key. */
export async function reconcileRun(run: AgentRun): Promise<AgentReceipt> {
  const input = {
    claim: { agent: run.agent, task: run.task, text: run.output, authorized: run.authorized },
    evidence: run.evidence,
  };
  const r = await buildReceipt(input);
  return {
    balanced: r.verdict.balanced,
    verdict: r.verdict,
    receiptId: r.receiptId,
    receiptHash: r.receiptHash,
    likelyCause: r.likelyCause,
  };
}
