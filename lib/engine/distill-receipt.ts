/**
 * Pacioli — the PROMOTION receipt (a Merkle-committable witness of a distilled deterministic rule).
 *
 * When a high-consensus jury agreement is distilled and HOLDOUT-GATED into an always-on deterministic rule
 * (distill.ts), the promotion itself must be tamper-evident: you should not be able to back-date a rule or
 * quietly edit the jury-consensus evidence that justified it. So each PromotedRule is content-addressed into
 * a single Merkle leaf over its FULL provenance (the jurors, the correlation-corrected effective votes, the
 * consensus gate, the derivation precision/support, and the out-of-sample holdout precision/support). The
 * promoted ruleset reduces to ONE Merkle root that drops into the same audit trail (merkle.ts) as the
 * reconciliation and cascade-equivalence receipts. Altering any provenance field changes the leaf hash and
 * the root.
 *
 * Zero dependencies (Web Crypto via crypto.ts); pure.
 */

import { canonicalJSON, sha256Hex } from "./crypto";
import { merkleRoot, merkleProof, verifyProof, type ProofStep } from "./merkle";
import { fingerprint } from "./receipt-hash";
import type { PromotedRule } from "./distill";

export interface PromotionReceipt {
  rule: PromotedRule;
  /** SHA-256 over the canonical promoted-rule record — one Merkle leaf for this promotion. */
  leafHash: string;
  /** Short display id, same `sha256:<fingerprint>` convention as a reconciliation receipt. */
  receiptId: string;
}

/** Content-hash one promoted rule (over the full rule record incl. its jury-consensus provenance). */
export async function buildPromotionReceipt(rule: PromotedRule): Promise<PromotionReceipt> {
  const leafHash = await sha256Hex(canonicalJSON(rule));
  return { rule, leafHash, receiptId: `sha256:${fingerprint(leafHash)}` };
}

/** True iff the rule still hashes to its receipt's `leafHash` — i.e. no provenance field was altered. */
export async function verifyPromotionReceipt(receipt: PromotionReceipt): Promise<boolean> {
  return (await sha256Hex(canonicalJSON(receipt.rule))) === receipt.leafHash;
}

export interface PromotionLedger {
  receipts: PromotionReceipt[];
  leaves: string[];
  /** The Merkle root committing to the whole promoted ruleset (EMPTY_ROOT when nothing was promoted). */
  root: string;
}

/** Build the promotion ledger: a receipt per promoted rule and the single Merkle root over them. */
export async function buildPromotionLedger(rules: readonly PromotedRule[]): Promise<PromotionLedger> {
  const receipts = await Promise.all(rules.map(buildPromotionReceipt));
  const leaves = receipts.map((r) => r.leafHash);
  const root = await merkleRoot(leaves);
  return { receipts, leaves, root };
}

/** An inclusion proof that a single promoted rule belongs to the committed ruleset root — without
 *  revealing the other rules. */
export async function provePromotion(ledger: PromotionLedger, index: number): Promise<ProofStep[]> {
  return merkleProof(ledger.leaves, index);
}

/** Verify a promoted rule's inclusion proof against a committed root. */
export async function verifyPromotionInclusion(leafHash: string, proof: ProofStep[], root: string): Promise<boolean> {
  return verifyProof(leafHash, proof, root);
}
