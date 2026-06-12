/**
 * Pacioli MCP — end-to-end smoke test.
 * Spawns the server over stdio, lists tools, calls reconcile_claim, and asserts the verdict.
 * Run: npx tsx mcp/smoke.ts   (exit 0 = OK)
 */

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverPath] });
  const client = new Client({ name: "pacioli-smoke", version: "1.0.0" });

  await client.connect(transport);

  const { tools } = await client.listTools();
  console.error("tools:", tools.map((t) => t.name).join(", "));

  const res = await client.callTool({
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

  const structured = res.structuredContent as { verdict?: string; receiptId?: string } | undefined;
  console.error("result:", JSON.stringify(structured, null, 2));

  await client.close();

  const ok =
    tools.some((t) => t.name === "reconcile_claim") &&
    structured?.verdict === "OUT_OF_BALANCE" &&
    typeof structured?.receiptId === "string";
  console.error(ok ? "SMOKE OK" : "SMOKE FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
