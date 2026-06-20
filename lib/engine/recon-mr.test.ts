import { describe, it, expect } from "vitest";
import { fuzzReconMr, reconMrViolations, RECON_MR, ALL_METAMORPHIC_PROPERTIES } from "./metamorphic";
import type { DiffInput } from "./types";

describe("RECON-MR — monotone-safety of early commit (safe policy)", () => {
  it("never flips a committed verdict across 20k fuzzed arrival streams", () => {
    const res = fuzzReconMr(20_000, 1234, { policy: "safe" });
    expect(res.failures).toEqual([]);
  });

  it("holds across independent seeds", () => {
    for (const seed of [1, 7, 42, 2026]) {
      expect(fuzzReconMr(5_000, seed, { policy: "safe" }).failures).toEqual([]);
    }
  });

  it("actually commits EARLY (the relation is not vacuously satisfied by always waiting)", () => {
    const res = fuzzReconMr(20_000, 1234, { policy: "safe" });
    expect(res.commits).toBe(res.cases); // every case reaches a commit
    expect(res.earlyCommits).toBeGreaterThan(0); // ...strictly before the stream ends
    expect(res.infoCompleteCommits).toBeGreaterThan(0); // ...by information-completeness, not just at the end
  });

  it("is exposed in the named relation superset", () => {
    expect(ALL_METAMORPHIC_PROPERTIES).toContain(RECON_MR);
  });
});

describe("RECON-MR — DETECTION (the relation can bite)", () => {
  // The negative analogue of metamorphic.negative.test.ts: prove the relation actually catches a
  // flip. The unsafe "stable-k" heuristic commits a balanced verdict before the (large) charge has
  // arrived; when it lands the class flips to flagged — a RECON-MR violation the harness must report.
  const flipsLate: DiffInput = {
    claim: {
      agent: "a",
      task: "book under $300",
      text: "booked",
      authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false },
    },
    evidence: { source: "email", merchant: "United", amountUsd: 5000, date: null, items: [], recurring: false, excerpt: "Total $5000" },
  };

  it("reports RECON-MR when stable-k(1) commits balanced and the late charge flips it", () => {
    const violations = reconMrViolations(flipsLate, {
      order: ["amount", "recurring", "addon"],
      reconcile: { policy: "stable-k", k: 1 },
    });
    expect(violations.map((v) => v.property)).toContain(RECON_MR);
  });

  it("reports NO violation for the same case under the monotone-safe policy", () => {
    expect(reconMrViolations(flipsLate, { order: ["amount", "recurring", "addon"], reconcile: { policy: "safe" } })).toEqual([]);
  });

  it("fuzzing the unsafe stable-k(1) heuristic surfaces real flips (so the safe-policy 0 is meaningful)", () => {
    const res = fuzzReconMr(20_000, 1234, { policy: "stable-k", k: 1 });
    expect(res.failures.length).toBeGreaterThan(0);
  });
});
