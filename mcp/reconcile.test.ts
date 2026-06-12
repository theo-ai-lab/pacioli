import { describe, it, expect } from "vitest";
import { reconcile, toDiffInput } from "./reconcile";

describe("MCP reconcile tool logic", () => {
  it("flags an overspend, diagnoses a cause, and returns a tamper-evident receipt id", async () => {
    const r = await reconcile({
      agent: "chatgpt-agent",
      task: "Book the cheapest nonstop to Austin under $300",
      claim: "Booked a nonstop for $278.",
      budgetUsd: 300,
      mayPurchase: true,
      merchant: "United Airlines",
      amountUsd: 378,
      items: ["seat selection", "trip insurance"],
      excerpt: "Total $378.00 charged.",
    });
    expect(r.balanced).toBe(false);
    expect(r.verdict).toBe("OUT_OF_BALANCE");
    expect(r.findings.some((f) => f.type === "OVERSPEND")).toBe(true);
    expect(r.deltaUsd).toBe(78);
    expect(r.likelyCause).toMatch(/add-ons|fees/i);
    expect(r.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("balances a clean research-only run", async () => {
    const r = await reconcile({
      agent: "claude-agent",
      task: "Compare three desks, don't buy anything",
      claim: "Compared three desks, no purchase.",
      mayPurchase: false,
      merchant: "—",
      amountUsd: 0,
      excerpt: "No order placed.",
    });
    expect(r.balanced).toBe(true);
    expect(r.verdict).toBe("BALANCED");
    expect(r.findings).toHaveLength(0);
  });

  it("flags an unauthorized recurring charge", async () => {
    const r = await reconcile({
      agent: "comet",
      task: "Start the free trial only",
      claim: "Activated the free trial, no charge.",
      mayRecur: false,
      merchant: "Stackly Pro",
      amountUsd: 14.99,
      recurring: true,
      recurringPeriod: "monthly",
      excerpt: "Monthly subscription active.",
    });
    expect(r.findings.some((f) => f.type === "UNAUTH_RECURRENCE")).toBe(true);
    expect(r.likelyCause).toMatch(/trial|subscription|recurring|opt-in/i);
  });

  it("maps flat MCP args onto the engine's DiffInput faithfully", () => {
    const input = toDiffInput({
      agent: "a",
      task: "t",
      claim: "c",
      budgetUsd: 100,
      mayPurchase: true,
      merchant: "m",
      amountUsd: 120,
      excerpt: "e",
    });
    expect(input.claim.authorized.budgetUsd).toBe(100);
    expect(input.evidence.amountUsd).toBe(120);
    expect(input.evidence.source).toBe("pasted");
  });
});
