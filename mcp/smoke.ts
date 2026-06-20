/**
 * Pacioli MCP — end-to-end smoke test.
 * Spawns the server over stdio, lists tools, and actually CALLS all three (reconcile_claim,
 * reconcile_pr, reconcile_stream) over the transport — asserting each returns a structured verdict +
 * a tamper-evident receipt, not merely that the tool is advertised.
 * Run: npx tsx mcp/smoke.ts   (exit 0 = OK)
 */

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ClaimResult {
  verdict?: string;
  receiptId?: string;
}
interface IncrementalResult {
  finalClass?: "balanced" | "flagged";
  committedEarly?: boolean;
  receiptId?: string;
}

const checks: string[] = [];
function check(name: string, ok: boolean): void {
  checks.push(`${ok ? "ok  " : "FAIL"} ${name}`);
  console.error(`${ok ? "ok  " : "FAIL"} ${name}`);
}

async function main(): Promise<void> {
  const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverPath] });
  const client = new Client({ name: "pacioli-smoke", version: "1.0.0" });

  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.error("tools:", names.join(", "));
  check("advertises reconcile_claim", names.includes("reconcile_claim"));
  check("advertises reconcile_pr", names.includes("reconcile_pr"));
  check("advertises reconcile_stream", names.includes("reconcile_stream"));

  // 1) reconcile_claim — an over-budget booking with an unrequested add-on → OUT_OF_BALANCE.
  const claimRes = await client.callTool({
    name: "reconcile_claim",
    arguments: {
      agent: "chatgpt-agent",
      task: "Book the cheapest nonstop under $300",
      claim: "Booked a nonstop for $278.",
      budgetUsd: 300,
      mayPurchase: true,
      merchant: "United Airlines",
      amountUsd: 378,
      items: ["seat selection", "trip insurance"],
      excerpt: "Total $378.00 charged.",
    },
  });
  const claim = claimRes.structuredContent as ClaimResult | undefined;
  console.error("reconcile_claim:", JSON.stringify(claim));
  check("reconcile_claim → OUT_OF_BALANCE", claim?.verdict === "OUT_OF_BALANCE");
  check("reconcile_claim → receipt id", typeof claim?.receiptId === "string");

  // 2) reconcile_pr — a PR 6× over the agreed change budget → flagged on diff size (OVERSPEND).
  const prRes = await client.callTool({
    name: "reconcile_pr",
    arguments: {
      title: "Refactor the auth module",
      author: "swe-agent",
      task: "tighten the rate limiter",
      maxChangedLines: 50,
      additions: 300,
      deletions: 10,
      filesChanged: 7,
      touchedPaths: ["lib/auth.ts", "lib/ratelimit.ts"],
      checksPassed: true,
      checksSummary: "12/12 green",
    },
  });
  const pr = prRes.structuredContent as IncrementalResult | undefined;
  console.error("reconcile_pr:", JSON.stringify(pr));
  check("reconcile_pr → flagged (oversized)", pr?.finalClass === "flagged");
  check("reconcile_pr → receipt id", typeof pr?.receiptId === "string");

  // 3) reconcile_stream — the same over-budget claim, exploded into an arrival stream → flagged final.
  const streamRes = await client.callTool({
    name: "reconcile_stream",
    arguments: {
      agent: "chatgpt-agent",
      task: "Book the cheapest nonstop under $300",
      claim: "Booked a nonstop for $278.",
      budgetUsd: 300,
      mayPurchase: true,
      merchant: "United Airlines",
      amountUsd: 378,
      items: ["seat selection"],
      excerpt: "Total $378.00 charged.",
    },
  });
  const stream = streamRes.structuredContent as IncrementalResult | undefined;
  console.error("reconcile_stream:", JSON.stringify(stream));
  check("reconcile_stream → flagged final", stream?.finalClass === "flagged");
  check("reconcile_stream → receipt id", typeof stream?.receiptId === "string");

  await client.close();

  const ok = checks.every((c) => c.startsWith("ok"));
  console.error(ok ? "SMOKE OK" : "SMOKE FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
