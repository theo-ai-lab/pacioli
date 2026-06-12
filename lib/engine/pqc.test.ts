import { describe, it, expect } from "vitest";
import { pqcAvailable, signMerkleRoot, verifyMerkleRoot } from "./pqc";

// The live crypto assertion runs once `npm install @noble/post-quantum` is done; until then it skips
// (the suite stays green) and the wiring test below asserts the clear activation error instead.
const available = await pqcAvailable();

describe("post-quantum Merkle-root signature (ML-DSA-65)", () => {
  it.skipIf(!available)("signs a Merkle root, verifies it, and rejects a tampered root", async () => {
    const root = "a".repeat(64);
    const sig = await signMerkleRoot(root, new Uint8Array(32).fill(7));
    expect(sig.algorithm).toBe("ML-DSA-65");
    expect(await verifyMerkleRoot(root, sig.signatureHex, sig.publicKeyHex)).toBe(true);
    expect(await verifyMerkleRoot("b".repeat(64), sig.signatureHex, sig.publicKeyHex)).toBe(false);
  });

  it("is wired and throws a clear activation message when the dep is absent", async () => {
    if (available) {
      expect(typeof signMerkleRoot).toBe("function");
      return;
    }
    await expect(signMerkleRoot("a".repeat(64))).rejects.toThrow(/npm install @noble\/post-quantum/);
  });
});
