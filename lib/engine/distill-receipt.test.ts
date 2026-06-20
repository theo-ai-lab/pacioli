import { describe, it, expect } from "vitest";
import {
  buildPromotionReceipt,
  verifyPromotionReceipt,
  buildPromotionLedger,
  provePromotion,
  verifyPromotionInclusion,
} from "./distill-receipt";
import { merkleRoot } from "./merkle";
import type { PromotedRule } from "./distill";

const rule = (atom: string, eff: number): PromotedRule => ({
  ruleId: `DISTILLED:${atom}`,
  type: "CLAIM_MISMATCH",
  atom,
  explanation: `fires on ${atom}`,
  provenance: {
    jurors: ["j0", "j1", "j2"],
    effectiveJurors: eff,
    meanPairwiseCorrelation: 0.2,
    consensusGate: { minAgreement: 2 / 3, minEffectiveJurors: 1.5 },
    derivationPrecision: 1,
    derivationSupport: 4,
    holdoutPrecision: 1,
    holdoutSupport: 3,
    splitSeed: 7,
    splitFraction: 0.5,
  },
});

describe("buildPromotionReceipt — content-addresses a promoted rule with its jury provenance", () => {
  it("a receipt verifies against its own rule, and the id is the sha256:<fingerprint> form", async () => {
    const receipt = await buildPromotionReceipt(rule("evidence-divergence-language", 2.58));
    expect(await verifyPromotionReceipt(receipt)).toBe(true);
    expect(receipt.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(receipt.leafHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TAMPERING with any provenance field breaks verification (the promotion is tamper-evident)", async () => {
    const receipt = await buildPromotionReceipt(rule("a", 2.58));
    // forge a higher effective-jurors count → must no longer hash to the committed leaf
    const forged = { ...receipt, rule: { ...receipt.rule, provenance: { ...receipt.rule.provenance, effectiveJurors: 4 } } };
    expect(await verifyPromotionReceipt(forged)).toBe(false);
  });

  it("is canonical: field order does not change the leaf hash", async () => {
    const r1 = rule("a", 2);
    const r2: PromotedRule = { explanation: r1.explanation, atom: r1.atom, type: r1.type, ruleId: r1.ruleId, provenance: r1.provenance };
    expect((await buildPromotionReceipt(r1)).leafHash).toBe((await buildPromotionReceipt(r2)).leafHash);
  });
});

describe("buildPromotionLedger — one Merkle root over the promoted ruleset + inclusion proofs", () => {
  it("commits every rule and yields verifying inclusion proofs without revealing the others", async () => {
    const rules = [rule("a", 2), rule("b", 3), rule("c", 1.5)];
    const ledger = await buildPromotionLedger(rules);
    expect(ledger.leaves).toHaveLength(3);
    expect(ledger.root).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.root).toBe(await merkleRoot(ledger.leaves)); // root matches the audit-trail primitive

    for (let i = 0; i < rules.length; i++) {
      const proof = await provePromotion(ledger, i);
      expect(await verifyPromotionInclusion(ledger.leaves[i], proof, ledger.root)).toBe(true);
    }
    // a wrong leaf does not verify against the root
    const proof0 = await provePromotion(ledger, 0);
    expect(await verifyPromotionInclusion(ledger.leaves[1], proof0, ledger.root)).toBe(false);
  });

  it("an empty ruleset commits to the canonical empty root (nothing promoted is still well-defined)", async () => {
    const ledger = await buildPromotionLedger([]);
    expect(ledger.leaves).toHaveLength(0);
    expect(ledger.root).toBe(await merkleRoot([]));
  });

  it("editing a rule changes the root (the committed ruleset cannot be back-dated)", async () => {
    const a = await buildPromotionLedger([rule("a", 2), rule("b", 3)]);
    const b = await buildPromotionLedger([rule("a", 2), rule("b", 2.99)]);
    expect(a.root).not.toBe(b.root);
  });
});
