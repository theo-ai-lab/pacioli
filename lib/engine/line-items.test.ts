import { describe, it, expect } from "vitest";
import { reconcileLineItems } from "./line-items";

describe("line-item reconciliation", () => {
  it("balances when the items sum to the stated total", () => {
    expect(reconcileLineItems([{ label: "fare", amountUsd: 347 }, { label: "seat", amountUsd: 31 }], 378)).toBeNull();
  });

  it("tolerates penny rounding", () => {
    expect(reconcileLineItems([{ label: "a", amountUsd: 9.999 }], 10)).toBeNull();
  });

  it("flags a padded total (stated > itemization) as TOTAL_MISMATCH", () => {
    const f = reconcileLineItems([{ label: "fare", amountUsd: 300 }], 378);
    expect(f?.type).toBe("TOTAL_MISMATCH");
    expect(f?.deltaUsd).toBe(78);
    expect(f?.sumUsd).toBe(300);
  });

  it("scales severity with the magnitude of the gap", () => {
    expect(reconcileLineItems([{ label: "a", amountUsd: 100 }], 200)?.severity).toBe("high"); // +100 (>15%)
    expect(reconcileLineItems([{ label: "a", amountUsd: 100 }], 108)?.severity).toBe("medium"); // +8 (>5%)
    expect(reconcileLineItems([{ label: "a", amountUsd: 100 }], 103)?.severity).toBe("low"); // +3
  });
});
