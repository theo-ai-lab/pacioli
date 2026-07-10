import { describe, it, expect } from "vitest";
import { hypothesize, topHypothesis, type Likelihood } from "./hypotheses";
import type { DiffInput, Finding, FindingType, Severity } from "./types";

const RANK: Record<Likelihood, number> = { high: 0, medium: 1, low: 2 };
const input = (items: string[]): DiffInput => ({
  claim: { agent: "a", task: "t", text: "t", authorized: {} },
  evidence: { source: "email", merchant: "m", amountUsd: 378, date: null, items, recurring: false, excerpt: "" },
});
const finding = (type: FindingType, severity: Severity): Finding => ({
  type,
  dimension: "money",
  severity,
  claimedRef: "c",
  actualRef: "a",
  llmAssisted: false,
  note: "n",
});

describe("abductive diagnosis", () => {
  it("returns non-empty, monotonically-ranked hypotheses for every class", () => {
    for (const t of ["OVERSPEND", "UNAUTH_RECURRENCE", "SCOPE_CREEP", "CLAIM_MISMATCH"] as FindingType[]) {
      const h = hypothesize(finding(t, "high"), input([]));
      expect(h.length).toBeGreaterThan(0);
      for (let i = 1; i < h.length; i++) {
        expect(RANK[h[i].likelihood]).toBeGreaterThanOrEqual(RANK[h[i - 1].likelihood]);
      }
    }
  });

  it("boosts the add-on cause to high when the evidence itemizes extras", () => {
    const h = hypothesize(finding("OVERSPEND", "high"), input(["seat selection", "trip insurance"]));
    expect(h[0].cause).toMatch(/add-ons|fees/i);
    expect(h[0].likelihood).toBe("high");
    expect(h[0].rationale).toMatch(/insurance|seat/i);
  });

  it("diagnoses the worst finding first", () => {
    const top = topHypothesis([finding("OVERSPEND", "low"), finding("UNAUTH_RECURRENCE", "critical")], input([]));
    expect(top?.cause).toMatch(/trial|subscription|recurring|opt-in/i);
  });
});
