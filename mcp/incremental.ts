/**
 * Pacioli MCP — the prefix / incremental reconciliation tools' logic (transport-free, unit-testable).
 *
 * Two reachable surfaces over engine modules that used to be library-only:
 *   • reconcilePr(...)         → lib/adapters/pr-reconcile.ts   (the per-PR adapter)
 *   • reconcileStreamTool(...) → lib/engine/prefix-reconcile.ts (the early-commit reconciler)
 *
 * Both answer the incremental question the one-shot engine (diff.ts) can't: when evidence arrives over
 * time, at which PREFIX can a verdict be committed, and is that commit monotone-safe? They never invent
 * a rule — they call the same deterministic engine — so a zero-findings result still means "the rules
 * found nothing", never "verified". Pure + deterministic; no key, no network. (Relative imports: this
 * runs under tsx, which does not resolve the app's `@/` tsconfig alias.)
 */

import { buildReceipt } from "../lib/engine/receipt";
import {
  reconcileStream,
  streamFromDiffInput,
  type InfoClass,
  type ReconcileRun,
} from "../lib/engine/prefix-reconcile";
import {
  prToDiffInput,
  reconcilePullRequest,
  type PullRequestClaim,
  type PullRequestEvidence,
} from "../lib/adapters/pr-reconcile";
import { toDiffInput, type ReconcileArgs } from "./reconcile";
import type { DiffInput } from "../lib/engine/types";

/** A policy choice shared by both tools: monotone-safe by default, k-stable opt-in. */
export type StreamPolicy = "safe" | "stable-k";

/** The compact, typed result both incremental tools return (the per-step trace plus the early-commit
 *  summary, with a tamper-evident receipt over the FINAL input — the same hash the one-shot tools emit). */
export interface IncrementalResult {
  /** Index of the first prefix the policy committed at, or null if it never committed before the end. */
  commitAt: number | null;
  committedClass: "balanced" | "flagged" | null;
  committedReason: string | null;
  /** True iff the commit happened strictly before the last signal — a genuine EARLY commit. */
  committedEarly: boolean;
  /** True iff every prefix at/after the commit kept the committed class (the monotone-safety obligation). */
  monotoneSafe: boolean;
  finalClass: "balanced" | "flagged";
  finalVerdict: {
    balanced: boolean;
    findings: Array<{
      type: string;
      dimension: string;
      severity: string;
      claimedRef: string;
      actualRef: string;
      note: string;
      llmAssisted: boolean;
    }>;
    deltaUsd?: number;
  };
  steps: Array<{
    step: number;
    verdictClass: "balanced" | "flagged";
    infoComplete: boolean;
    kStable: boolean;
    reason: string;
    committed: boolean;
  }>;
  receiptId: string;
  receiptHash: string;
  note: string;
}

/** Shape a ReconcileRun + its final DiffInput into the wire result, minting the canonical receipt. */
async function summarize(run: ReconcileRun, finalInput: DiffInput, note: string): Promise<IncrementalResult> {
  const { receiptId, receiptHash } = await buildReceipt(finalInput);
  return {
    commitAt: run.commitAt,
    committedClass: run.committedClass,
    committedReason: run.committedReason,
    committedEarly: run.committedEarly,
    monotoneSafe: run.heldToEnd,
    finalClass: run.finalClass,
    finalVerdict: {
      balanced: run.finalVerdict.balanced,
      findings: run.finalVerdict.findings.map((f) => ({
        type: f.type,
        dimension: f.dimension,
        severity: f.severity,
        claimedRef: f.claimedRef,
        actualRef: f.actualRef,
        note: f.note,
        llmAssisted: f.llmAssisted,
      })),
      deltaUsd: run.finalVerdict.deltaUsd,
    },
    steps: run.steps.map((s) => ({
      step: s.step,
      verdictClass: s.verdictClass,
      infoComplete: s.infoComplete,
      kStable: s.kStable,
      reason: s.reason,
      committed: s.committed,
    })),
    receiptId,
    receiptHash,
    note,
  };
}

// ── reconcile_pr ─────────────────────────────────────────────────────────────────────────────────

/** Flat, agent-friendly arguments for the per-PR adapter (the FDE / agent-PR angle). */
export interface PrArgs {
  number?: number;
  title: string;
  body?: string;
  author: string;
  task?: string;
  scope?: string;
  constraints?: string[];
  /** false ⇒ review-only mandate: ANY code change is out of scope (SCOPE_CREEP). Defaults to true. */
  mayModifyCode?: boolean;
  /** Authorized change budget in lines (additions + deletions). Omitted ⇒ no size cap. */
  maxChangedLines?: number;
  claimsTestsPass?: boolean;
  claimedBehaviors?: string[];
  // ── evidence (arrives incrementally: diff stats first, CI last) ──
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
  touchedPaths?: string[];
  checksPassed?: boolean | null;
  checksSummary?: string;
  merged?: boolean;
  // ── policy ──
  policy?: StreamPolicy;
  k?: number;
}

export async function reconcilePr(a: PrArgs): Promise<IncrementalResult> {
  const claim: PullRequestClaim = {
    number: a.number,
    title: a.title,
    body: a.body ?? "",
    author: a.author,
    task: a.task,
    scope: a.scope,
    constraints: a.constraints,
    mayModifyCode: a.mayModifyCode,
    maxChangedLines: a.maxChangedLines,
    claimsTestsPass: a.claimsTestsPass,
    claimedBehaviors: a.claimedBehaviors,
  };
  const evidence: PullRequestEvidence = {
    additions: a.additions,
    deletions: a.deletions,
    filesChanged: a.filesChanged,
    touchedPaths: a.touchedPaths,
    checksPassed: a.checksPassed,
    checksSummary: a.checksSummary,
    merged: a.merged,
  };
  const run = reconcilePullRequest(claim, evidence, { policy: a.policy, k: a.k });

  // "claims tests pass" vs a failing CI is the fuzzy CLAIM_MISMATCH residual the deterministic engine
  // abstains on — call it out honestly rather than letting the zero finding read as "verified".
  const residual =
    a.claimsTestsPass && a.checksPassed === false
      ? " The PR also claims tests pass while CI failed — that is the CLAIM_MISMATCH residual, abstained here for the gated LLM judge."
      : "";
  const note = run.committedEarly
    ? `Committed a "${run.committedClass}" verdict at signal ${run.commitAt} (${run.committedReason}), before all PR signals arrived${run.heldToEnd ? "" : " (NOT monotone-safe under this policy)"}.${residual}`
    : `Committed only at the final signal.${residual}`;
  return summarize(run, prToDiffInput(claim, evidence), note);
}

// ── reconcile_stream ─────────────────────────────────────────────────────────────────────────────

/** A complete claim+evidence (same flat shape as reconcile_claim) plus the arrival order to simulate. */
export interface StreamArgs extends ReconcileArgs {
  /** The order the flip-capable evidence classes arrive in. Default amount → recurring → items. */
  revealOrder?: InfoClass[];
  policy?: StreamPolicy;
  k?: number;
}

export async function reconcileStreamTool(a: StreamArgs): Promise<IncrementalResult> {
  const input = toDiffInput(a);
  // Explode the COMPLETE input into a plausible arrival stream, then reconcile it prefix by prefix.
  const increments = streamFromDiffInput(input, { order: a.revealOrder });
  const run = reconcileStream(increments, { policy: a.policy, k: a.k });
  const note = run.committedEarly
    ? `From a complete claim+evidence exploded into a ${increments.length}-step arrival stream, a "${run.committedClass}" verdict was information-determined at prefix ${run.commitAt} (${run.committedReason})${run.heldToEnd ? ", monotone-safe" : " — NOT monotone-safe under this policy"}.`
    : "The verdict could only be committed once the whole stream had arrived.";
  return summarize(run, input, note);
}
