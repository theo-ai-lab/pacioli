import { describe, it, expect, vi } from "vitest";
import type { DiffInput, Finding, Verdict } from "@pacioli-app/engine";

// NEGATIVE PATH: prove the metamorphic harness can actually DETECT a broken engine — a checker that
// always returned [] would pass every positive test. We mock diff() (now imported from the
// @pacioli-app/engine workspace) with a deliberately broken engine, keeping every other export
// intact, and assert the corresponding property names show up as violations.
vi.mock("@pacioli-app/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pacioli-app/engine")>()),
  diff: (i: DiffInput): Verdict => {
    const findings: Finding[] = [];
    // BROKEN: fires OVERSPEND only at EXACTLY $400 — charging more "fixes" it (violates MP-CHARGE-MONOTONE).
    if (i.evidence.amountUsd === 400) {
      findings.push({
        type: "OVERSPEND",
        dimension: "money",
        severity: "high",
        claimedRef: "claim",
        actualRef: "evidence",
        llmAssisted: false,
        note: "broken-engine overspend",
      });
    }
    return { balanced: findings.length === 0, findings, deltaUsd: 100 };
  },
}));

import { metamorphicViolations } from "./metamorphic";

const base: DiffInput = {
  claim: { agent: "a", task: "book under $300", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "Air", amountUsd: 400, date: null, items: [], recurring: false, excerpt: "Total: $400" },
};

describe("metamorphic harness — violation DETECTION (broken-engine mock)", () => {
  it("reports MP-CHARGE-MONOTONE when charging more removes an overspend", () => {
    const violations = metamorphicViolations(base);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.property)).toContain("MP-CHARGE-MONOTONE");
  });
});
