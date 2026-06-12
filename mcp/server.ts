/**
 * Pacioli MCP server.
 *
 * Exposes the reconciliation engine as ONE read-only Model Context Protocol tool, so a live agent
 * (Claude Desktop, the Claude CLI, …) can call Pacioli mid-task to self-issue a receipt before/after it
 * claims an action — double-entry bookkeeping for agents, in the loop instead of only post-hoc.
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

const server = new McpServer({ name: "pacioli", version: "1.0.0" });

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("pacioli MCP server running on stdio (tool: reconcile_claim)");
}

main().catch((err) => {
  console.error("pacioli MCP server failed:", err);
  process.exit(1);
});
