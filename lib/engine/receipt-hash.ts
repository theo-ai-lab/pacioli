/**
 * Pacioli — verifiable receipts (content addressing + tamper evidence).
 *
 * Every receipt is hashed (SHA-256) over a CANONICAL serialization of {claim, evidence, verdict},
 * so the hash is a stable content address and any later edit changes it. This turns a receipt from a
 * rendering into a tamper-evident *witness* — a property regulated domains (finance, legal) demand.
 * Zero dependencies: Web Crypto, available in Node 20+ and every modern browser.
 */

import { canonicalJSON, sha256Hex } from "./crypto";
import type { DiffInput, Verdict } from "./types";

/** Content hash of a receipt: SHA-256 over the canonical {claim, evidence, verdict}. */
export async function receiptHash(input: DiffInput, verdict: Verdict): Promise<string> {
  return sha256Hex(canonicalJSON({ claim: input.claim, evidence: input.evidence, verdict }));
}

/** Short display fingerprint (first 16 hex chars). */
export const fingerprint = (hash: string): string => hash.slice(0, 16);

/** True iff the receipt's content still hashes to `hash` — i.e. it hasn't been altered. */
export async function verifyReceipt(input: DiffInput, verdict: Verdict, hash: string): Promise<boolean> {
  return (await receiptHash(input, verdict)) === hash;
}

/** Link receipts into a tamper-evident session chain (each entry binds to the previous). */
export async function chainHash(prevHash: string, receipt: string): Promise<string> {
  return sha256Hex(`${prevHash}:${receipt}`);
}
