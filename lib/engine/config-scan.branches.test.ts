import { describe, it, expect } from "vitest";
import { scanConfig } from "./config-scan";

describe("config scanner — previously-uncovered branches", () => {
  it("flags authorized recurrence as RECURRENCE_ALLOWED (medium)", () => {
    const f = scanConfig({ authorized: { mayRecur: true }, tools: { allowed: [] } }).find((x) => x.code === "RECURRENCE_ALLOWED");
    expect(f?.severity).toBe("medium");
  });

  it("treats a zero budget as no cap (the <=0 boundary)", () => {
    const out = scanConfig({ authorized: { mayPurchase: true, budgetUsd: 0 }, tools: { allowed: [] } });
    expect(out.map((f) => f.code)).toContain("NO_BUDGET_CAP");
  });

  it("treats a null budget as no cap", () => {
    const out = scanConfig({ authorized: { mayPurchase: true, budgetUsd: null }, tools: { allowed: [] } });
    expect(out.map((f) => f.code)).toContain("NO_BUDGET_CAP");
  });

  it("a positive budget satisfies the cap requirement", () => {
    const out = scanConfig({ authorized: { mayPurchase: true, budgetUsd: 100 }, tools: { allowed: [] } });
    expect(out.map((f) => f.code)).not.toContain("NO_BUDGET_CAP");
  });
});
