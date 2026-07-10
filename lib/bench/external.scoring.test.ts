import { describe, it, expect } from "vitest";
import { runAdapter, type Mapper, type MappedTask } from "./external";
import type { DiffInput } from "@pacioli-app/engine";

const input = (amountUsd: number, budgetUsd: number): DiffInput => ({
  claim: { agent: "a", task: "book", text: "booked", authorized: { budgetUsd, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "M", amountUsd, date: null, items: [], recurring: false, excerpt: `Total: $${amountUsd}` },
});

interface Raw {
  id: string;
  task: MappedTask;
}
const mapper: Mapper<Raw> = (r) => r.task;

describe("external-benchmark adapter — fp/fn scoring branches", () => {
  it("a missed gold label scores as a FALSE NEGATIVE (recall 0)", () => {
    // Gold says OVERSPEND but the mapped input is clean — the engine (correctly) won't fire.
    const report = runAdapter([{ id: "fn", task: { id: "fn", input: input(100, 300), expect: ["OVERSPEND"] } }], mapper);
    expect(report.byClass.OVERSPEND).toMatchObject({ tp: 0, fp: 0, fn: 1, recall: 0 });
  });

  it("an unexpected firing scores as a FALSE POSITIVE (precision 0)", () => {
    // Engine fires (400 > 300) but gold expects nothing.
    const report = runAdapter([{ id: "fp", task: { id: "fp", input: input(400, 300), expect: [] } }], mapper);
    expect(report.byClass.OVERSPEND).toMatchObject({ tp: 0, fp: 1, fn: 0, precision: 0 });
  });

  it("an untouched class reports null precision/recall, never 0/0 masquerading as a score", () => {
    const report = runAdapter([{ id: "x", task: { id: "x", input: input(100, 300), expect: [] } }], mapper);
    expect(report.byClass.CLAIM_MISMATCH.precision).toBeNull();
    expect(report.byClass.CLAIM_MISMATCH.recall).toBeNull();
  });
});
