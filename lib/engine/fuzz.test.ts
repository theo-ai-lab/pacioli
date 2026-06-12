import { describe, it, expect } from "vitest";
import { fuzz } from "./fuzz";

describe("property-based invariant fuzzing (the engine against SPEC.md)", () => {
  it("holds every contract over 25k boundary-stressed mutated cases", () => {
    const res = fuzz(25_000, 1234);
    expect(res.determinismFailures).toBe(0);
    // surface the offending input if this ever fails
    expect(res.failures).toEqual([]);
  });

  it("holds across independent seeds (reproducible)", () => {
    for (const seed of [1, 7, 42, 2026]) {
      const res = fuzz(5_000, seed);
      expect(res.determinismFailures).toBe(0);
      expect(res.failures).toEqual([]);
    }
  });
});
