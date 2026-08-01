/**
 * Pacioli — the durable ledger's hash chain (shared by the writer and the verifier).
 *
 * Content addressing proves a receipt's *contents* match its id. It says nothing about the ledger
 * those receipts sit in: without a chain, an `UPDATE`/`DELETE` straight against the sqlite file
 * leaves no trace. So every persisted row carries
 *
 *   leafHash  = SHA-256 over the canonical IMMUTABLE facts of the row
 *   prevHash  = the previous row's entryHash (or GENESIS for the first)
 *   entryHash = chainHash(prevHash, leafHash)
 *
 * and each scope (the whole store, plus every session ledger) carries a committed count, head and
 * Merkle root. An edit breaks leafHash; a delete or a reorder breaks the prevHash link; a truncation
 * of the newest rows breaks count/head. `npm run verify:ledger -- <db>` walks all of it.
 *
 * WHAT THE LEAF COMMITS TO — and what it deliberately does not. `seenCount` is the mutable replay
 * counter (a replay of the same content-addressed receipt bumps it in place), so it is NOT covered:
 * the chain commits to the immutable facts of each distinct receipt, not to how many times it was
 * re-submitted. Everything else in the row is covered.
 *
 * Zero new dependencies — the primitives are the engine's (`chainHash`, `merkleRoot`, Web Crypto).
 */
import { canonicalJSON, sha256Hex, chainHash, merkleRoot } from "@pacioli-app/engine";

/** The anchor a chain starts from when nothing precedes it. */
export const GENESIS = "pacioli-ledger-genesis";

/** The scope key for "the whole store". A session key can never be empty (the routes coerce `""`
 *  to undefined before it reaches the store), so the empty string is a collision-free sentinel. */
export const WHOLE_STORE = "";

/** The immutable facts of one persisted receipt — exactly what the leaf hash commits to. */
export interface LedgerFacts {
  receiptId: string;
  receiptHash: string;
  balanced: boolean;
  findingTypes: string[];
  agent: string;
  merchant: string;
  deltaUsd: number | null;
  createdAt: number;
  sessionKey?: string;
}

/** SHA-256 over the canonical immutable facts. One definition, used by both the writer and the
 *  verifier, so the two can never drift into disagreeing about what was committed. */
export function leafHash(f: LedgerFacts): Promise<string> {
  return sha256Hex(
    canonicalJSON({
      receiptId: f.receiptId,
      receiptHash: f.receiptHash,
      balanced: f.balanced,
      findingTypes: f.findingTypes,
      agent: f.agent,
      merchant: f.merchant,
      deltaUsd: f.deltaUsd ?? null,
      createdAt: f.createdAt,
      sessionKey: f.sessionKey ?? null,
    }),
  );
}

/** entryHash for a row: binds its contents to everything that came before it. */
export const entryHashFor = (prevHash: string, leaf: string): Promise<string> => chainHash(prevHash, leaf);

/** The Merkle root a scope commits to, over its leaves in chain order. */
export const scopeRoot = (leaves: string[]): Promise<string> => merkleRoot(leaves);

/**
 * Should a scope re-seal its Merkle root after this append?
 *
 * The chain is what makes every row tamper-evident, and it costs O(1) per write. The Merkle root is
 * the inclusion-proof commitment and costs O(n) hashes over the scope's leaves — so re-sealing it on
 * every single write would quietly turn an append into an O(n) rehash on a long ledger. Instead a
 * scope re-seals whenever at least `count/512` receipts are unsealed (always, for the first 512), which
 * keeps the amortized cost flat while leaving the root current for any ledger of realistic size. The
 * unsealed tail is never unprotected: the chain covers it, and the verifier checks the root against
 * exactly the prefix it was sealed over.
 */
export const shouldReseal = (count: number, rootCount: number): boolean =>
  count - rootCount >= Math.max(1, Math.floor(count / 512));
