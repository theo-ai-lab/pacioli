import { describe, it, expect } from "vitest";
import { reconcileLineItems } from "./line-items";

describe("line-item reconciliation — boundary inputs", () => {
  it("an empty itemization against a stated total is a full-delta mismatch", () => {
    const f = reconcileLineItems([], 50);
    expect(f?.type).toBe("TOTAL_MISMATCH");
    expect(f?.deltaUsd).toBe(50);
  });

  it("negative line items (refunds) participate in the sum", () => {
    expect(reconcileLineItems([{ label: "fare", amountUsd: 100 }, { label: "refund", amountUsd: -20 }], 80)).toBeNull();
  });

  it("the EXACT tolerance boundary balances (|delta| <= tolerance)", () => {
    expect(reconcileLineItems([{ label: "a", amountUsd: 10 }], 10.01)).toBeNull(); // delta = penny, inclusive
    expect(reconcileLineItems([{ label: "a", amountUsd: 10 }], 10.02)?.type).toBe("TOTAL_MISMATCH"); // one past it
  });
});
