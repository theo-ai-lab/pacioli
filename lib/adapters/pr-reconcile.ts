/**
 * Pacioli — GitHub PULL-REQUEST adapter for the prefix reconciler (FDE / agent-PR angle).
 *
 * An agent opens a PR and CLAIMS something: "this PR implements X, stays small, and all tests
 * pass." The evidence — diff size, touched files, CI result — arrives over SECONDS to MINUTES, not
 * at once. This thin adapter maps that PR-shaped claim onto the existing reconcile contract so the
 * deterministic engine (diff.ts) + the prefix reconciler (prefix-reconcile.ts) can decide, at each
 * arriving signal, whether to commit a verdict early ("this PR is 6× the agreed size — flag it
 * before CI even finishes") or wait.
 *
 * It is deliberately THIN: it only TRANSLATES PR fields into the engine's vocabulary; it invents no
 * new rules. The faithful mappings onto the existing deterministic rules are:
 *
 *   • "change budget" (authorized changed-line count) → authorized.budgetUsd
 *     actual lines changed (additions + deletions)    → evidence.amountUsd
 *     ⇒ OVERSPEND fires when the PR balloons beyond the agreed size.
 *
 *   • review-only mandate (mayModifyCode === false)   → authorized.mayPurchase = false
 *     ⇒ SCOPE_CREEP fires if the agent changed code (lines > 0) when told only to review.
 *
 *   • recurrence is N/A for a PR                       → authorized.mayRecur = true, recurring = false
 *     ⇒ UNAUTH_RECURRENCE can never fire (documented, intentional).
 *
 *   • touched paths                                    → evidence.items (out-of-scope files surface)
 *   • CI summary / merge state                         → evidence.excerpt (the citation line)
 *
 * ── WHERE THE LLM JUDGE PLUGS IN ────────────────────────────────────────────────────────────────
 * The fuzzy residual — "the PR claims all tests pass / claims it does X, but does it?" — is exactly
 * the CLAIM_MISMATCH class the deterministic engine ABSTAINS on. Feed `prToDiffInput(...)` to the
 * (gated, injectable, mock-testable) streamed judge in lib/engine/streaming-judge.ts:
 *
 *     import { streamJudge } from "../engine/streaming-judge";
 *     const res = await streamJudge(prToDiffInput(claim, evidence), { model }).final();
 *
 * In production `model` is the hosted Anthropic model behind ANTHROPIC_API_KEY; in tests it is an
 * injected MockLanguageModelV3 (NO key) — the plumbing is proven, never a fabricated number.
 */

import type { DiffInput } from "@pacioli-app/engine";
import {
  reconcileStream,
  type ReconcileIncrement,
  type ReconcileOptions,
  type ReconcileRun,
} from "../engine/prefix-reconcile";

/** A GitHub-PR-shaped claim: what the agent asserts, plus the contract it was authorized against. */
export interface PullRequestClaim {
  number?: number;
  title: string;
  body: string;
  /** The acting agent (maps to AgentClaim.agent), e.g. "claude-agent", "swe-agent". */
  author: string;
  /** The agent asserted CI is/will be green ("all tests pass"). Audited as the CLAIM_MISMATCH residual. */
  claimsTestsPass?: boolean;
  /** Behaviors the PR claims ("adds feature X", "no public API change"). Residual material. */
  claimedBehaviors?: string[];

  // ── the contract this PR was authorized against (from the issue / task) ──
  /** The task/issue text the PR is supposed to satisfy. Defaults to `title`. */
  task?: string;
  /** Authorized scope, e.g. "implement the rate limiter", "review only — do not modify code". */
  scope?: string;
  /** Hard constraints from the task. */
  constraints?: string[];
  /** false ⇒ review-only mandate: ANY code change is out of scope (SCOPE_CREEP). Defaults to true. */
  mayModifyCode?: boolean;
  /** Authorized change budget in lines (additions + deletions). undefined ⇒ no size cap. */
  maxChangedLines?: number;
}

/** What actually happened to the PR — arrives incrementally (diff stats first, CI last). */
export interface PullRequestEvidence {
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
  touchedPaths?: string[];
  /** CI result; null/undefined ⇒ checks still running (an UNSEEN evidence class). */
  checksPassed?: boolean | null;
  checksSummary?: string;
  merged?: boolean;
}

/** Total lines changed, or null when no diff stat has arrived yet (keeps the "amount" class unseen). */
function changedLines(e: PullRequestEvidence): number | null {
  if (typeof e.additions !== "number" && typeof e.deletions !== "number") return null;
  return (e.additions ?? 0) + (e.deletions ?? 0);
}

function prSlug(c: PullRequestClaim): string {
  const n = c.number ? `PR #${c.number}: ` : "";
  return `${n}${c.title}`.slice(0, 200);
}

/** The agent's narrative claim — the text the LLM residual audits. */
function prClaimText(c: PullRequestClaim): string {
  const parts = [c.body];
  if (c.claimedBehaviors?.length) parts.push(`Claimed: ${c.claimedBehaviors.join("; ")}.`);
  if (c.claimsTestsPass) parts.push("The agent states all tests pass.");
  return parts.filter(Boolean).join(" ");
}

/** A short, redacted citation line from the CI / merge signals (privacy invariant: no raw logs). */
function prExcerpt(c: PullRequestClaim, e: PullRequestEvidence): string {
  const bits: string[] = [];
  if (typeof e.checksPassed === "boolean") bits.push(`CI ${e.checksPassed ? "passed" : "FAILED"}`);
  if (e.checksSummary) bits.push(e.checksSummary);
  if (e.merged) bits.push("merged");
  return bits.join(" — ") || prSlug(c);
}

/**
 * One-shot mapping of a PR claim + (possibly partial) evidence to a full DiffInput. Use this to feed
 * BOTH the deterministic engine and the LLM residual judge.
 */
export function prToDiffInput(claim: PullRequestClaim, evidence: PullRequestEvidence = {}): DiffInput {
  return {
    claim: {
      agent: claim.author,
      task: claim.task ?? claim.title,
      text: prClaimText(claim),
      authorized: {
        budgetUsd: claim.maxChangedLines ?? null, // "budget" = authorized changed-line count
        scope: claim.scope,
        constraints: claim.constraints,
        mayPurchase: claim.mayModifyCode ?? true, // review-only ⇒ false ⇒ any change is SCOPE_CREEP
        mayRecur: true, // recurrence is N/A for a PR — never fire UNAUTH_RECURRENCE
      },
    },
    evidence: {
      source: "agent-report",
      merchant: prSlug(claim),
      amountUsd: changedLines(evidence), // "amount" = lines changed (vs the line budget)
      date: null,
      items: evidence.touchedPaths ?? [],
      recurring: false,
      excerpt: prExcerpt(claim, evidence),
    },
  };
}

/**
 * Map a PR to the ARRIVAL STREAM of reconcile increments, modeling how PR signals actually land:
 *   step 0 — the contract + PR header (authorization is fixed at task time; recurrence is N/A);
 *   step 1 — the diff size lands (additions + deletions) → an oversized/over-budget PR can be
 *            committed as OVERSPEND HERE, before CI runs;
 *   step 2 — touched files land (out-of-scope files surface) → closes the addon/sent classes;
 *   step 3 — CI completes → the final citation line (terminal increment).
 */
export function prToIncrements(claim: PullRequestClaim, evidence: PullRequestEvidence = {}): ReconcileIncrement[] {
  const full = prToDiffInput(claim, evidence);
  return [
    {
      authorized: full.claim.authorized,
      authFinal: true,
      claim: { agent: full.claim.agent, task: full.claim.task, text: full.claim.text },
      // recurrence is known-false up front for a PR → settle it immediately so it never blocks commit
      evidence: { source: "agent-report", merchant: full.evidence.merchant, recurring: false, excerpt: prSlug(claim) },
    },
    { evidence: { amountUsd: full.evidence.amountUsd } },
    { evidence: { items: full.evidence.items }, closes: ["addon", "sent"] },
    { evidence: { excerpt: full.evidence.excerpt }, final: true },
  ];
}

/**
 * Reconcile a PR incrementally: returns the per-signal trace plus the early-commit decision.
 * Default policy is the monotone-safe one (commit only when information-complete or the stream ends).
 */
export function reconcilePullRequest(
  claim: PullRequestClaim,
  evidence: PullRequestEvidence = {},
  opts: ReconcileOptions = {},
): ReconcileRun {
  return reconcileStream(prToIncrements(claim, evidence), opts);
}
