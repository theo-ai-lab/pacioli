import { describe, it, expect } from "vitest";
import { adversarialAudit, type AdversarialCase } from "./adversarial";
import type { Authorization, DiffInput, MerchantEvidence } from "@pacioli-app/engine";

const mk = (authorized: Authorization, ev: Partial<MerchantEvidence>): DiffInput => ({
  claim: { agent: "x", task: "t", text: "c", authorized },
  evidence: { source: "pasted", merchant: "m", amountUsd: null, date: null, items: [], recurring: false, excerpt: "", ...ev },
});

describe("AI-directed adversarial harness", () => {
  it("counts agreement when the engine catches what the generator expected", async () => {
    const gen = async (): Promise<AdversarialCase[]> => [
      { rationale: "clear overspend", expect: ["OVERSPEND"], input: mk({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 200 }) },
    ];
    const r = await adversarialAudit(gen);
    expect(r.agreements).toBe(1);
    expect(r.blindSpots).toHaveLength(0);
  });

  it("reports a blind spot when the engine misses an expected finding", async () => {
    const gen = async (): Promise<AdversarialCase[]> => [
      // generator wrongly expects SCOPE_CREEP, but mayPurchase=true & no add-on → engine won't fire it
      { rationale: "thinks any over-budget is scope creep", expect: ["SCOPE_CREEP"], input: mk({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 200 }) },
    ];
    const r = await adversarialAudit(gen);
    expect(r.blindSpots).toHaveLength(1);
    expect(r.blindSpots[0].missed).toContain("SCOPE_CREEP");
  });

  it("treats a CLAIM_MISMATCH expectation as abstention-by-design, not a blind spot", async () => {
    const gen = async (): Promise<AdversarialCase[]> => [
      { rationale: "wrong-item wording", expect: ["CLAIM_MISMATCH"], input: mk({ budgetUsd: 300, mayPurchase: true }, { amountUsd: 278 }) },
    ];
    const r = await adversarialAudit(gen);
    expect(r.agreements).toBe(1);
    expect(r.blindSpots).toHaveLength(0);
  });
});
