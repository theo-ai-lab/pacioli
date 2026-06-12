import { describe, it, expect } from "vitest";
import { buildReceipt } from "./receipt";
import type { DiffInput } from "./types";

const overspend: DiffInput = {
  claim: { agent: "a", task: "book under $300", text: "booked within budget", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "United", amountUsd: 378, date: null, items: [], recurring: false, excerpt: "Total: $378.00" },
};

describe("buildReceipt (the shared receipt pipeline)", () => {
  it("assembles the canonical receipt: verdict + content-addressed id + cause", async () => {
    const r = await buildReceipt(overspend);
    expect(r.verdict.balanced).toBe(false);
    expect(r.verdict.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(r.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof r.likelyCause === "string" || r.likelyCause === null).toBe(true);
  });

  it("is deterministic — identical input yields the identical receipt id", async () => {
    const [a, b] = [await buildReceipt(overspend), await buildReceipt(overspend)];
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.receiptHash).toBe(b.receiptHash);
  });
});
