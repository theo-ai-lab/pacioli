/**
 * @pacioli-app/engine — the zero-dependency deterministic core of Pacioli.
 *
 * Claim-vs-evidence reconciliation for AI agents:
 *   - `diff`            — the deterministic rule engine (every finding cites both sides)
 *   - `buildReceipt`    — diff → content hash → top abductive cause → `sha256:<fingerprint>` id
 *   - `receiptHash` / `verifyReceipt` / `chainHash` — tamper-evident content addressing
 *   - `merkleRoot` / `merkleProof` / `verifyProof`  — the Merkle audit trail
 *   - `checkInvariants` — the engine contract (SPEC.md) as executable predicates
 *
 * Zero runtime dependencies. Web Crypto only (Node 20+ and all modern browsers).
 */

export * from "./types";
export * from "./diff";
export * from "./receipt";
export * from "./receipt-hash";
export * from "./merkle";
export * from "./spec";
export * from "./crypto";
export * from "./scope-rules";
export * from "./hypotheses";
