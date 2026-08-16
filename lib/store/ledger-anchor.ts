/**
 * Pacioli — the off-box anchor.
 *
 * `verifyLedger` establishes that a file is internally self-consistent. It cannot establish that the
 * file is the same ledger anyone committed to, because an adversary with write access can re-derive
 * every leaf, link, head and root after editing — or delete everything and re-seal the result as an
 * empty ledger. Both outcomes are self-consistent. The tamper drill models both and classifies them
 * as boundaries for exactly this reason.
 *
 * An anchor is the missing half: a commitment to the whole store's head, root and count, taken while
 * the record was trusted. Verification against one answers "is this the same ledger?" rather than
 * "is this file consistent?".
 *
 * WHERE THE SECURITY LIVES. Not here. An anchor stored beside the database is taken by the same
 * attacker who took the database, and this module cannot stop that. Its value comes entirely from
 * custody — a CI artifact, a signed commit, another machine, a printout. What this module does
 * guarantee is that the distinction is never silent: a report says whether it was checked against an
 * anchor, so an unanchored pass cannot be mistaken for an anchored one.
 */
import { verifyLedger } from "./verify-ledger";
import { WHOLE_STORE } from "./ledger-chain";

export interface LedgerAnchor {
  /** Always the whole store: a per-session anchor would not notice a session being dropped. */
  scope: string;
  /** The last entry hash in the chain at the moment of anchoring. */
  head: string;
  /** The Merkle root the store had sealed. */
  root: string;
  /** Receipts present. A wipe-and-reseal changes this even when the roots collide. */
  count: number;
  /** How many leaves the root was sealed over. */
  rootCount: number;
  /** When the commitment was taken. Informational — the hashes are what decide. */
  sealedAt: string;
}

/**
 * Take an anchor from a ledger that currently verifies.
 *
 * Refuses an unverifiable one on purpose: anchoring a record that already fails its own walk would
 * commit to whatever an attacker had already done, and a later comparison against that commitment
 * would then report agreement. An anchor is only worth what the record was worth when it was taken.
 */
export async function anchorFromLedger(path: string, now: () => Date = () => new Date()): Promise<LedgerAnchor> {
  const report = await verifyLedger(path);
  if (!report.ok) {
    const first = report.faults[0];
    throw new Error(
      `refusing to anchor ${path}: it does not verify` + (first ? ` — [${first.kind}] ${first.detail}` : ""),
    );
  }
  const whole = report.scopes.find((s) => s.scope === WHOLE_STORE);
  if (!whole) throw new Error(`refusing to anchor ${path}: no whole-store commitment to anchor to`);
  return {
    scope: WHOLE_STORE,
    head: whole.head,
    root: whole.root,
    count: whole.receipts,
    rootCount: whole.rootCount,
    sealedAt: now().toISOString(),
  };
}

/** Serialise for storage. Deliberately plain JSON: an anchor a human can read is one they can keep. */
export function serializeAnchor(a: LedgerAnchor): string {
  return JSON.stringify(a, null, 2) + "\n";
}

export function parseAnchor(text: string): LedgerAnchor {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("anchor is not an object");
  const o = raw as Record<string, unknown>;
  for (const k of ["head", "root", "sealedAt"] as const) {
    if (typeof o[k] !== "string" || o[k] === "") throw new Error(`anchor field ${k} is missing or not a string`);
  }
  for (const k of ["count", "rootCount"] as const) {
    if (typeof o[k] !== "number" || !Number.isSafeInteger(o[k]) || (o[k] as number) < 0) {
      throw new Error(`anchor field ${k} is not a readable count`);
    }
  }
  // A root is sealed OVER leaves, so it can never cover more than exist. verify-ledger
  // rejects exactly this shape in chain_state; an anchor claiming it is malformed for
  // the same reason, and accepting it would let a nonsense commitment drive the
  // extension check.
  if ((o.rootCount as number) > (o.count as number)) {
    throw new Error(
      `anchor commits a root over ${o.rootCount} leaves but only ${o.count} receipt(s) — not a readable commitment`,
    );
  }
  // Scope was serialised, coerced from anything, and then never compared. The
  // comparison only ever handles the whole store, so an anchor naming any other scope
  // is one this verifier cannot honour — refusing it beats silently rewriting it to ""
  // and reporting a confident verdict about a different scope than the file claims.
  if (o.scope !== undefined && o.scope !== WHOLE_STORE) {
    throw new Error(
      `anchor scope ${JSON.stringify(o.scope)} is not the whole store — only whole-store anchors are supported`,
    );
  }
  return {
    scope: WHOLE_STORE,
    head: o.head as string,
    root: o.root as string,
    count: o.count as number,
    rootCount: o.rootCount as number,
    sealedAt: o.sealedAt as string,
  };
}
