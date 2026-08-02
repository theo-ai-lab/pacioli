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
 * WHAT THE LEAF COMMITS TO — and what it deliberately does not. Exactly two columns of a persisted
 * row sit outside it, and both are deliberate:
 *
 *   `seenCount` — the mutable replay counter (a replay of the same content-addressed receipt bumps it
 *     in place). The chain commits to the immutable facts of each DISTINCT receipt, not to how many
 *     times one was re-submitted.
 *
 *   `seq` — the row's POSITION. It orders the walk, orders a scope's leaves and picks a prune's
 *     victims, but every one of those uses is RELATIVE, and the relative order is ALREADY committed to,
 *     by prevHash/entryHash. Only the order is load-bearing; the numbers themselves are not. So a
 *     renumbering that preserves the order (`UPDATE receipts SET seq = seq*2`) is undetectable — and
 *     inert: a real prune then destroys the same rows and spares the same survivors, every leaf, link,
 *     head and root is byte-identical, and the single column that does move (`chain_state.prunedSeq`)
 *     is written, carried forward and never read back as a decision by anything. A renumbering that
 *     does NOT preserve the order is a different thing entirely and is caught (`chain-break`, or the
 *     verifier's strict-increase check). Pinned by `boundary-seq-renumber` in the tamper drill and by
 *     the seeded renumbering properties in ledger-chain.test.ts.
 *
 *     The limit of "inert": pushing a position past 2^53 while preserving the order is a DENIAL OF
 *     SERVICE, not a forgery. node:sqlite will not narrow an integer that wide to a JS number, so the
 *     store's next append REJECTS (the caller is told; /api/reconcile reports `stored: false`) and the
 *     verifier reports a located `malformed-row` rather than walking. Availability, loudly — never a
 *     receipt silently accepted or silently passed.
 *
 * DECISION, recorded rather than left silent: `seq` stays OUT of the leaf. Adding it would change
 * every leaf hash that exists — the committed dataset/reference-ledger.db immediately stops verifying
 * (measured: `[row-altered] seq 1 (sha256:0f3c1a2b4d5e6f70)`), and every deployed store would have to
 * be regenerated — in exchange for closing an exposure that cannot alter a verdict, a survivor set or
 * a commitment. The order is already committed to; paying that price for the numbering is not a trade
 * worth making. Everything else in the row is covered.
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
