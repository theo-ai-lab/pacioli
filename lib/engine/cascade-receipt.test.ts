import { describe, it, expect } from "vitest";
import { cascadeMetrics, goldOracleJudge, EQUIV_CASCADE } from "./cascade";
import { buildCascadeReceipt, verifyCascadeReceipt } from "./cascade-receipt";
import { merkleRoot, merkleProof, verifyProof } from "@pacioli-app/engine";
import { loadSeed, loadIncidents } from "./dataset";
import type { GroundTruthSample } from "@pacioli-app/engine";

const corpus = (): GroundTruthSample[] => [...loadSeed(), ...loadIncidents()];

async function metricsFixture() {
  const rows = corpus();
  return cascadeMetrics(rows.map((r) => r.input), goldOracleJudge(rows), { judgeLabel: "gold-oracle" });
}

describe("cascade-receipt — the EQUIV-CASCADE relation as a Merkle-committable witness", () => {
  it("witnesses the named relation and carries the measured numbers", async () => {
    const m = await metricsFixture();
    const receipt = await buildCascadeReceipt(m);
    expect(receipt.relation).toBe(EQUIV_CASCADE);
    expect(receipt.boundary).toBe(m.boundary);
    expect(receipt.alpha).toBe(m.alpha);
    expect(receipt.losslessViolations).toBe(m.losslessViolations);
    expect(receipt.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("round-trips: a freshly built receipt verifies against its own leaf hash", async () => {
    const receipt = await buildCascadeReceipt(await metricsFixture());
    expect(await verifyCascadeReceipt(receipt)).toBe(true);
  });

  it("is content-addressed: identical metrics → identical leaf hash (deterministic)", async () => {
    const a = await buildCascadeReceipt(await metricsFixture());
    const b = await buildCascadeReceipt(await metricsFixture());
    expect(a.leafHash).toBe(b.leafHash);
    expect(a.receiptId).toBe(b.receiptId);
  });

  it("is TAMPER-EVIDENT: altering any reported number breaks verification", async () => {
    const receipt = await buildCascadeReceipt(await metricsFixture());
    expect(await verifyCascadeReceipt({ ...receipt, alpha: receipt.alpha + 0.01 })).toBe(false);
    expect(await verifyCascadeReceipt({ ...receipt, losslessViolations: receipt.losslessViolations + 1 })).toBe(false);
    expect(await verifyCascadeReceipt({ ...receipt, disagreementRate: 0.123456 })).toBe(false);
  });

  it("commits into the SAME Merkle audit trail as the receipts it summarizes (inclusion proof verifies)", async () => {
    const receipt = await buildCascadeReceipt(await metricsFixture());
    // mix the equivalence leaf in with some sibling leaves and prove inclusion
    const leaves = ["a".repeat(64), "b".repeat(64), receipt.leafHash, "c".repeat(64)];
    const idx = leaves.indexOf(receipt.leafHash);
    const root = await merkleRoot(leaves);
    const proof = await merkleProof(leaves, idx);
    expect(await verifyProof(receipt.leafHash, proof, root)).toBe(true);
    // a tampered number changes the leaf, hence the root — the inclusion proof no longer verifies
    const tampered = await buildCascadeReceipt({ ...(await metricsFixture()), alpha: 0.999999 });
    expect(await verifyProof(tampered.leafHash, proof, root)).toBe(false);
  });
});
