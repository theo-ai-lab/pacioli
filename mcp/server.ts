/**
 * Pacioli MCP server.
 *
 * Exposes the reconciliation engine as three READ-ONLY Model Context Protocol tools
 * (reconcile_claim, reconcile_pr, reconcile_stream), so a live agent (Claude Desktop, the Claude
 * CLI, …) can call Pacioli mid-task to self-issue a receipt before/after it claims an action —
 * double-entry bookkeeping for agents, in the loop instead of only post-hoc.
 *
 * Uses the production-current V1 SDK (@modelcontextprotocol/sdk), NOT the pre-alpha V2
 * (@modelcontextprotocol/server). Stdio transport: never write to stdout (logs go to stderr).
 *
 * Run: `npm run mcp`   ·   Wire-up: see mcp/README.md
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reconcile, type ReconcileArgs } from "./reconcile";
import { reconcilePr, reconcileStreamTool, type PrArgs, type StreamArgs } from "./incremental";

const server = new McpServer({ name: "pacioli", version: "1.0.0" });

// Shared output shape for the two INCREMENTAL tools (reconcile_pr / reconcile_stream): the per-prefix
// trace + early-commit summary + a tamper-evident receipt over the final input. Citations are kept on
// every finding (the engine's citation invariant — a structured client must not be the one that drops them).
const findingSchema = z.object({
  type: z.string(),
  dimension: z.string(),
  severity: z.string(),
  claimedRef: z.string(),
  actualRef: z.string(),
  note: z.string(),
  llmAssisted: z.boolean(),
});
const incrementalOutputSchema = {
  commitAt: z.number().nullable().describe("First prefix the policy committed at, or null if never before the end."),
  committedClass: z.enum(["balanced", "flagged"]).nullable(),
  committedReason: z.string().nullable(),
  committedEarly: z.boolean().describe("True iff committed strictly before the last signal — a genuine EARLY commit."),
  monotoneSafe: z.boolean().describe("True iff every prefix at/after the commit kept the committed class."),
  finalClass: z.enum(["balanced", "flagged"]),
  finalVerdict: z.object({
    balanced: z.boolean(),
    findings: z.array(findingSchema),
    deltaUsd: z.number().optional(),
  }),
  steps: z.array(
    z.object({
      step: z.number(),
      verdictClass: z.enum(["balanced", "flagged"]),
      infoComplete: z.boolean(),
      kStable: z.boolean(),
      reason: z.string(),
      committed: z.boolean(),
    }),
  ),
  receiptId: z.string(),
  receiptHash: z.string(),
  note: z.string(),
};

server.registerTool(
  "reconcile_claim",
  {
    title: "Reconcile an agent's claim against evidence",
    description:
      "Pacioli — double-entry bookkeeping for AI agents. Reconcile what an agent CLAIMED it did against " +
      "independent confirmation evidence; deterministically flags OVERSPEND / UNAUTH_RECURRENCE / SCOPE_CREEP, " +
      "diagnoses a likely cause, and returns a tamper-evident SHA-256 receipt id. Deterministic, no key, no network. " +
      "Fuzzy wording/constraint mismatches (CLAIM_MISMATCH) are abstained by design.",
    inputSchema: {
      // NOTE (V1 SDK): inputSchema is a RAW Zod shape, not z.object(...).
      agent: z.string().describe("Which agent acted, e.g. 'chatgpt-agent'."),
      task: z.string().describe("The user's original instruction."),
      claim: z.string().describe("What the agent says it did (booked / bought / subscribed)."),
      budgetUsd: z.number().nullish().describe("Authorized budget in USD, if any."),
      mayPurchase: z.boolean().optional().describe("Was any purchase authorized?"),
      mayRecur: z.boolean().optional().describe("Was a recurring charge authorized?"),
      constraints: z.array(z.string()).optional().describe("Hard constraints, e.g. ['nonstop','cheapest']."),
      merchant: z.string().describe("The merchant / counterparty from the evidence."),
      amountUsd: z.number().nullish().describe("Amount actually charged, from the evidence."),
      recurring: z.boolean().optional().describe("Is the charge recurring?"),
      recurringPeriod: z.enum(["weekly", "monthly", "annual"]).optional(),
      items: z.array(z.string()).optional().describe("Line items present in the evidence."),
      date: z.string().nullish().describe("ISO date of the actual action/charge."),
      excerpt: z.string().describe("A short, redacted excerpt of the confirmation evidence."),
    },
    outputSchema: {
      verdict: z.string(),
      balanced: z.boolean(),
      // Full finding shape, citations included — a Finding cannot exist without citing the exact
      // lines that prove it (the engine's invariant), and the STRUCTURED surface typed clients
      // consume must not be the one that drops them.
      findings: z.array(
        z.object({
          type: z.string(),
          dimension: z.string(),
          severity: z.string(),
          claimedRef: z.string(),
          actualRef: z.string(),
          note: z.string(),
          llmAssisted: z.boolean(),
        }),
      ),
      deltaUsd: z.number().optional(),
      likelyCause: z.string().nullable(),
      receiptId: z.string(),
      receiptHash: z.string(),
    },
  },
  async (args) => {
    const r = await reconcile(args as ReconcileArgs);
    const structuredContent = {
      verdict: r.verdict,
      balanced: r.balanced,
      findings: r.findings,
      deltaUsd: r.deltaUsd,
      likelyCause: r.likelyCause,
      receiptId: r.receiptId,
      receiptHash: r.receiptHash,
    };
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent };
  },
);

server.registerTool(
  "reconcile_pr",
  {
    title: "Reconcile a pull request's claim against incremental evidence",
    description:
      "Pacioli — reconcile what an agent's PULL REQUEST claims (implements X, stays within the agreed change " +
      "size, review-only) against the evidence that arrives over time (diff stats, touched files, CI). Reports, " +
      "signal by signal, the EARLIEST prefix at which a verdict can be committed — e.g. flag an oversized PR as " +
      "OVERSPEND before CI even finishes — and whether that early commit is monotone-safe. Deterministic, no key, " +
      "no network. 'claims tests pass' vs a failing CI is the CLAIM_MISMATCH residual, abstained for the LLM judge.",
    inputSchema: {
      title: z.string().describe("The PR title."),
      body: z.string().optional().describe("The PR description / the agent's narrative claim."),
      author: z.string().describe("The acting agent, e.g. 'claude-agent', 'swe-agent'."),
      number: z.number().optional().describe("PR number, if any."),
      task: z.string().optional().describe("The task/issue the PR is supposed to satisfy. Defaults to the title."),
      scope: z.string().optional().describe("Authorized scope, e.g. 'implement the rate limiter', 'review only'."),
      constraints: z.array(z.string()).optional().describe("Hard constraints from the task."),
      mayModifyCode: z.boolean().optional().describe("false ⇒ review-only mandate: ANY code change is SCOPE_CREEP. Default true."),
      maxChangedLines: z.number().optional().describe("Authorized change budget in lines (additions + deletions). Omitted ⇒ no cap."),
      claimsTestsPass: z.boolean().optional().describe("The agent asserted CI is/will be green."),
      claimedBehaviors: z.array(z.string()).optional().describe("Behaviors the PR claims ('adds feature X')."),
      additions: z.number().nullish().describe("Lines added (part of the diff-size signal)."),
      deletions: z.number().nullish().describe("Lines deleted (part of the diff-size signal)."),
      filesChanged: z.number().nullish().describe("Number of files changed."),
      touchedPaths: z.array(z.string()).optional().describe("Paths the PR touched (out-of-scope files surface here)."),
      checksPassed: z.boolean().nullish().describe("CI result; null/omitted ⇒ checks still running (an unseen class)."),
      checksSummary: z.string().optional().describe("Short CI summary, e.g. '12/12 green' or '3 of 12 failed'."),
      merged: z.boolean().optional().describe("Whether the PR was merged."),
      policy: z.enum(["safe", "stable-k"]).optional().describe("'safe' (default, monotone-safe) or 'stable-k' (earlier, riskier)."),
      k: z.number().optional().describe("Stability window for policy 'stable-k' (default 2)."),
    },
    outputSchema: incrementalOutputSchema,
  },
  async (args) => {
    const r = await reconcilePr(args as PrArgs);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: { ...r } };
  },
);

server.registerTool(
  "reconcile_stream",
  {
    title: "Reconcile a claim against evidence that arrives incrementally",
    description:
      "Pacioli — incremental reconciliation. Takes a COMPLETE claim+evidence (the same fields as reconcile_claim), " +
      "explodes it into a plausible arrival STREAM (header → amount → recurrence → line items), and reports the " +
      "earliest prefix at which the deterministic verdict is information-determined — i.e. how much evidence you " +
      "actually need before a verdict is monotone-safe to commit. Deterministic, no key, no network. Use it to " +
      "answer 'can I decide now, or must I wait for more confirmation?' without re-running the engine by hand.",
    inputSchema: {
      agent: z.string().describe("Which agent acted, e.g. 'chatgpt-agent'."),
      task: z.string().describe("The user's original instruction."),
      claim: z.string().describe("What the agent says it did (booked / bought / subscribed)."),
      budgetUsd: z.number().nullish().describe("Authorized budget in USD, if any."),
      mayPurchase: z.boolean().optional().describe("Was any purchase authorized?"),
      mayRecur: z.boolean().optional().describe("Was a recurring charge authorized?"),
      constraints: z.array(z.string()).optional().describe("Hard constraints, e.g. ['nonstop','cheapest']."),
      merchant: z.string().describe("The merchant / counterparty from the evidence."),
      amountUsd: z.number().nullish().describe("Amount actually charged, from the evidence."),
      recurring: z.boolean().optional().describe("Is the charge recurring?"),
      recurringPeriod: z.enum(["weekly", "monthly", "annual"]).optional(),
      items: z.array(z.string()).optional().describe("Line items present in the evidence."),
      date: z.string().nullish().describe("ISO date of the actual action/charge."),
      excerpt: z.string().describe("A short, redacted excerpt of the confirmation evidence."),
      revealOrder: z
        .array(z.enum(["amount", "recurring", "addon", "sent"]))
        .optional()
        .describe("Order the flip-capable evidence classes arrive in. Default amount → recurring → items."),
      policy: z.enum(["safe", "stable-k"]).optional().describe("'safe' (default, monotone-safe) or 'stable-k'."),
      k: z.number().optional().describe("Stability window for policy 'stable-k' (default 2)."),
    },
    outputSchema: incrementalOutputSchema,
  },
  async (args) => {
    const r = await reconcileStreamTool(args as StreamArgs);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: { ...r } };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("pacioli MCP server running on stdio (tools: reconcile_claim, reconcile_pr, reconcile_stream)");
}

main().catch((err) => {
  console.error("pacioli MCP server failed:", err);
  process.exit(1);
});
