/**
 * Pacioli — Merkle audit trail.
 *
 * Receipt content-hashes are batched into a Merkle tree, yielding a single root that commits to the
 * whole session. Tampering with any receipt changes the root (forensic chain of custody), and an
 * inclusion PROOF shows that one receipt is in the committed set WITHOUT revealing the others — the
 * honest, right-sized form of selective transparency (no SNARK required). Zero dependencies.
 */

import { sha256Hex } from "./crypto";

// Domain-separated node hash (ordered: an audit log preserves sequence).
const hashPair = (left: string, right: string): Promise<string> => sha256Hex(`\x01${left}:${right}`);
const EMPTY_ROOT = (): Promise<string> => sha256Hex("\x00pacioli-empty");

export interface ProofStep {
  sibling: string;
  position: "left" | "right";
}

/** The Merkle root committing to an ordered list of leaf hashes. */
export async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return EMPTY_ROOT();
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last if odd
      next.push(await hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

/** An inclusion proof for the leaf at `index` (the sibling hashes from leaf up to the root). */
export async function merkleProof(leaves: string[], index: number): Promise<ProofStep[]> {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  const proof: ProofStep[] = [];
  let idx = index;
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      if (i === idx || i + 1 === idx) {
        proof.push(idx % 2 === 0 ? { sibling: right, position: "right" } : { sibling: left, position: "left" });
      }
      next.push(await hashPair(left, right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Verify a leaf belongs to `root` given only its inclusion proof — not the other leaves. */
export async function verifyProof(leaf: string, proof: ProofStep[], root: string): Promise<boolean> {
  let acc = leaf;
  for (const step of proof) {
    acc = step.position === "right" ? await hashPair(acc, step.sibling) : await hashPair(step.sibling, acc);
  }
  return acc === root;
}
