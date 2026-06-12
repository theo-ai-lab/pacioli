import { describe, it, expect } from "vitest";
import { reconcileRun } from "./langchain";

describe("agent-framework adapter (reconcileRun)", () => {
  it("reconciles a run into a tamper-evident receipt and flags overspend", async () => {
    const r = await reconcileRun({
      agent: "langchain-agent",
      task: "book a flight under $300",
      output: "booked within your budget",
      authorized: { budgetUsd: 300, mayPurchase: true },
      evidence: { source: "pasted", merchant: "United", amountUsd: 378, date: null, items: [], recurring: false, excerpt: "$378" },
    });
    expect(r.balanced).toBe(false);
    expect(r.verdict.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(r.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.likelyCause).not.toBeNull();
  });

  it("returns a balanced receipt for a clean run", async () => {
    const r = await reconcileRun({
      agent: "a",
      task: "book",
      output: "booked",
      authorized: { budgetUsd: 300, mayPurchase: true },
      evidence: { source: "pasted", merchant: "U", amountUsd: 278, date: null, items: [], recurring: false, excerpt: "$278" },
    });
    expect(r.balanced).toBe(true);
    expect(r.verdict.findings).toHaveLength(0);
  });
});
