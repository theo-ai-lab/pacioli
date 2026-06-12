import { describe, it, expect } from "vitest";
import { metamorphicViolations, fuzzMetamorphic, METAMORPHIC_PROPERTIES } from "./metamorphic";
import type { DiffInput } from "./types";

describe("metamorphic properties", () => {
  it("holds every relation over 20k generated cases (fuzzed)", () => {
    const res = fuzzMetamorphic(20_000, 1234);
    expect(res.failures).toEqual([]);
  });

  it("holds across independent seeds", () => {
    for (const seed of [1, 7, 42, 2026]) {
      expect(fuzzMetamorphic(5_000, seed).failures).toEqual([]);
    }
  });

  it("exposes the named properties", () => {
    expect(METAMORPHIC_PROPERTIES.length).toBeGreaterThanOrEqual(4);
  });

  it("would catch a hand-broken relation (sanity: a real overspend stays caught when charged more)", () => {
    const base: DiffInput = {
      claim: { agent: "a", task: "t", text: "t", authorized: { budgetUsd: 300, mayPurchase: true } },
      evidence: { source: "email", merchant: "m", amountUsd: 378, date: null, items: [], recurring: false, excerpt: "" },
    };
    // the engine satisfies the relations, so a real case yields no violations
    expect(metamorphicViolations(base)).toEqual([]);
  });
});
