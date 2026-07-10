import { describe, it, expect } from "vitest";
import { runAdapter, type Mapper } from "./external";
import type { DiffInput } from "@pacioli-app/engine";

interface Raw {
  kind: "overspend" | "clean" | "nonfinancial";
  budget: number;
  amount: number;
}

const mapper: Mapper<Raw> = (r, i) => {
  if (r.kind === "nonfinancial") return null; // no money/scope dimension → out of Pacioli's lane
  const input: DiffInput = {
    claim: { agent: "ext", task: "buy", text: "done", authorized: { budgetUsd: r.budget, mayPurchase: true } },
    evidence: { source: "pasted", merchant: "m", amountUsd: r.amount, date: null, items: [], recurring: false, excerpt: "" },
  };
  return { id: `t${i}`, input, expect: r.kind === "overspend" ? ["OVERSPEND"] : [] };
};

describe("external benchmark adapter", () => {
  it("maps the in-scope subset, skips out-of-scope, and scores per class", () => {
    const tasks: Raw[] = [
      { kind: "overspend", budget: 100, amount: 200 },
      { kind: "clean", budget: 100, amount: 90 },
      { kind: "nonfinancial", budget: 0, amount: 0 },
    ];
    const r = runAdapter(tasks, mapper);
    expect(r.total).toBe(3);
    expect(r.mapped).toBe(2); // the non-financial task is honestly excluded
    expect(r.coverage).toBeCloseTo(2 / 3);
    expect(r.flagged).toBe(1);
    expect(r.byClass.OVERSPEND).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
  });

  it("reports zero coverage when nothing maps", () => {
    const r = runAdapter([{ kind: "nonfinancial", budget: 0, amount: 0 }] as Raw[], mapper);
    expect(r.mapped).toBe(0);
    expect(r.coverage).toBe(0);
  });
});
