import { describe, it, expect } from "vitest";
import { merkleRoot, merkleProof, verifyProof } from "./merkle";
import { receiptHash } from "./receipt-hash";
import { diff } from "./diff";
import type { DiffInput } from "./types";

const mk = (amount: number): DiffInput => ({
  claim: { agent: "a", task: "t", text: "t", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "email", merchant: "m", amountUsd: amount, date: "2026-06-14", items: [], recurring: false, excerpt: "x" },
});

async function leaves(amounts: number[]): Promise<string[]> {
  return Promise.all(amounts.map((a) => receiptHash(mk(a), diff(mk(a)))));
}

describe("Merkle audit trail", () => {
  it("produces a deterministic root over a session of receipts", async () => {
    const l = await leaves([100, 378, 9.99, 329, 214]);
    expect(await merkleRoot(l)).toBe(await merkleRoot(l));
    expect(await merkleRoot(l)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every receipt has an inclusion proof that verifies against the root", async () => {
    const l = await leaves([100, 378, 9.99, 329, 214, 42, 7]); // odd count exercises duplicate-last
    const root = await merkleRoot(l);
    for (let i = 0; i < l.length; i++) {
      const proof = await merkleProof(l, i);
      expect(await verifyProof(l[i], proof, root)).toBe(true);
    }
  });

  it("selective transparency: a proof verifies membership without the other leaves", async () => {
    const l = await leaves([100, 378, 9.99, 329]);
    const root = await merkleRoot(l);
    const proof = await merkleProof(l, 2);
    // verifier is given ONLY the leaf, its proof, and the root — never the sibling receipts' contents
    expect(await verifyProof(l[2], proof, root)).toBe(true);
  });

  it("tampering with a receipt breaks its proof and changes the root", async () => {
    const l = await leaves([100, 378, 9.99, 329]);
    const root = await merkleRoot(l);
    const proof = await merkleProof(l, 1);
    const forged = await receiptHash(mk(999), diff(mk(999)));
    expect(await verifyProof(forged, proof, root)).toBe(false);
    const tampered = [...l];
    tampered[1] = forged;
    expect(await merkleRoot(tampered)).not.toBe(root);
  });

  it("handles the empty and single-leaf sessions", async () => {
    expect(await merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
    const one = await leaves([378]);
    expect(await verifyProof(one[0], await merkleProof(one, 0), await merkleRoot(one))).toBe(true);
  });
});
