/**
 * Pacioli — the CASCADE-EQUIVALENCE receipt (a Merkle-committable witness of the EQUIV-CASCADE relation).
 *
 * The existing receipt (receipt-hash.ts) content-addresses ONE reconciliation. This records the cascade's
 * EQUIVALENCE relation — alpha / disagreementRate / losslessViolations over a measured set — as its own
 * content-addressed leaf, so the lossless guarantee is committed into the SAME Merkle audit trail
 * (merkle.ts) as the receipts it summarizes. Tampering with any reported cascade number changes the leaf
 * hash, hence the session root: the equivalence claim is itself tamper-evident, not a prose footnote.
 *
 * Zero dependencies (Web Crypto via crypto.ts); pure.
 */

import { canonicalJSON, sha256Hex } from "@pacioli-app/engine";
import { EQUIV_CASCADE, type CascadeMetrics } from "./cascade";
import { fingerprint } from "@pacioli-app/engine";

export interface CascadeReceipt {
  /** The named relation this receipt witnesses. */
  relation: typeof EQUIV_CASCADE;
  boundary: string;
  regime: CascadeMetrics["regime"];
  locus: CascadeMetrics["locus"];
  judge: string;
  policy: CascadeMetrics["policy"];
  n: number;
  alpha: number;
  escalationRate: number;
  disagreementRate: number;
  losslessViolations: number;
  skippedResidualFindings: number;
  /** SHA-256 over the canonical relation record — a single Merkle leaf for this equivalence claim. */
  leafHash: string;
  /** Short display id, same `sha256:<fingerprint>` convention as a reconciliation receipt. */
  receiptId: string;
}

/** The canonical, hashable relation record (the fields shared by a metric and a receipt; excludes the
 *  derived hash fields). */
type RelationRecord = Omit<CascadeReceipt, "leafHash" | "receiptId">;

function relationRecord(m: CascadeMetrics): RelationRecord {
  return {
    relation: EQUIV_CASCADE,
    boundary: m.boundary,
    regime: m.regime,
    locus: m.locus,
    judge: m.judge,
    policy: m.policy,
    n: m.n,
    alpha: m.alpha,
    escalationRate: m.escalationRate,
    disagreementRate: m.disagreementRate,
    losslessViolations: m.losslessViolations,
    skippedResidualFindings: m.skippedResidualFindings,
  };
}

/** Build the cascade-equivalence receipt for a measured set. `leafHash` is ready to drop into the leaf
 *  array passed to `merkleRoot` (merkle.ts), committing the equivalence claim to the session root. */
export async function buildCascadeReceipt(m: CascadeMetrics): Promise<CascadeReceipt> {
  const record = relationRecord(m);
  const leafHash = await sha256Hex(canonicalJSON(record));
  return { ...record, leafHash, receiptId: `sha256:${fingerprint(leafHash)}` };
}

/** True iff `receipt` still hashes to its `leafHash` — i.e. no reported cascade number was altered. */
export async function verifyCascadeReceipt(receipt: CascadeReceipt): Promise<boolean> {
  const record = relationRecord(receipt);
  return (await sha256Hex(canonicalJSON(record))) === receipt.leafHash;
}
