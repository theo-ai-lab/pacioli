/**
 * Pacioli — shared receipt assembly (single source of truth).
 *
 * Every surface that prints a receipt (the MCP tool, the HTTP API, the framework adapter) runs the
 * SAME pipeline: diff → content hash → top abductive cause → `sha256:<fingerprint>` id. Centralizing
 * it here means a change to the id format or the hash inputs is one edit, not three synchronized ones
 * — three drifting copies of a tamper-evidence pipeline would defeat its own point.
 */
import { diff } from "./diff";
import { receiptHash, fingerprint } from "./receipt-hash";
import { topHypothesis } from "./hypotheses";
import type { DiffInput, Verdict } from "./types";

export interface BuiltReceipt {
  verdict: Verdict;
  /** Content-addressed id — a tamper-evident fingerprint of {claim, evidence, verdict}. */
  receiptId: string;
  receiptHash: string;
  likelyCause: string | null;
}

/** Run the deterministic engine over one input and assemble the canonical receipt. */
export async function buildReceipt(input: DiffInput): Promise<BuiltReceipt> {
  const verdict = diff(input);
  const hash = await receiptHash(input, verdict);
  const cause = topHypothesis(verdict.findings, input);
  return {
    verdict,
    receiptId: `sha256:${fingerprint(hash)}`,
    receiptHash: hash,
    likelyCause: cause?.cause ?? null,
  };
}
