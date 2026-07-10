/**
 * Pacioli — PREFIX / INCREMENTAL reconciliation (early-commit decision).
 *
 * The deterministic engine (diff.ts) reconciles a COMPLETE claim+evidence pair. But evidence
 * does not always arrive at once: a confirmation email lands, then the line items, then the
 * recurring flag; an agent narrates a PR, then the diff stats, then CI. This module reconciles a
 * PARTIAL (still-arriving) stream of increments and answers ONE question at every prefix:
 *
 *     "Is the partial ledger information-complete enough to COMMIT a verdict now,
 *      or must we WAIT for more evidence?"
 *
 * It does NOT replace diff.ts — it CALLS it. Each prefix is materialized into a full DiffInput
 * (unknown evidence filled with NEUTRAL defaults) and scored by the same deterministic engine, so
 * the prefix verdict can never disagree with the final engine verdict on the same facts.
 *
 * ── THE EARLY-COMMIT RULE ─────────────────────────────────────────────────────────────────────
 * A verdict has exactly two CLASSES: "balanced" (green, zero findings) and "flagged" (red, ≥1
 * finding). Within "flagged", a re-tag (e.g. SCOPE_CREEP→UNAUTH_RECURRENCE under RECUR-DOMINANCE)
 * is NOT a class change. We commit a class early when EITHER:
 *
 *   (1) INFORMATION-COMPLETE (the strong, monotone-safe rule). No still-unsettled evidence class
 *       can flip the current class to the opposite class — proven by materializing the *worst-case
 *       incriminating* AND *worst-case exculpating* completion of every unsettled class (and every
 *       combination) and checking the class is invariant. This is the rule that makes early commit
 *       MONOTONE-SAFE: if the maximal/minimal futures cannot flip it, no real future can. The
 *       authorization (the user's contract) must be settled first; an unknown authorization can
 *       move anything, so we conservatively wait.
 *
 *   (2) k-STABLE (a weaker heuristic, opt-in via policy "stable-k"). The class has been identical
 *       across the last k increments. This commits sooner but is NOT monotone-safe on its own — a
 *       late surprise can still flip it. We expose it, fuzz it (RECON-MR), and DEFAULT to the safe
 *       policy. Use stable-k only when a fast provisional verdict is worth the flip risk.
 *
 * The default policy is "safe": commit only on information-completeness (or once the stream ends).
 * Under "safe", a committed class provably never flips — the property the RECON-MR metamorphic
 * relation (lib/engine/metamorphic.ts) fuzzes.
 *
 * Zero new dependencies; pure and deterministic, exactly like diff.ts.
 */

import { diff } from "@pacioli-app/engine";
import type { AgentClaim, Authorization, DiffInput, MerchantEvidence, Verdict } from "@pacioli-app/engine";

// ── verdict class ───────────────────────────────────────────────────────────────────────────────

export type VerdictClass = "balanced" | "flagged";
export const classify = (v: Verdict): VerdictClass => (v.balanced ? "balanced" : "flagged");
export const opposite = (c: VerdictClass): VerdictClass => (c === "balanced" ? "flagged" : "balanced");

/**
 * The flip-capable EVIDENCE classes — the dimensions of incoming evidence that a deterministic rule
 * keys on and that could therefore move the verdict between classes:
 *   amount     → OVERSPEND, SCOPE_CREEP(spent-when-mayPurchase===false)
 *   recurring  → UNAUTH_RECURRENCE, and (via RECUR-DOMINANCE) suppression of SCOPE_CREEP
 *   addon      → SCOPE_CREEP (an unrequested up-sell product appears in items)
 *   sent       → SCOPE_CREEP (a "do not send" prohibition is shown violated in items/excerpt)
 */
export type InfoClass = "amount" | "recurring" | "addon" | "sent";
export const INFO_CLASSES: readonly InfoClass[] = ["amount", "recurring", "addon", "sent"];

// ── the stream contract ───────────────────────────────────────────────────────────────────────

/**
 * One arriving increment of the partial ledger. Scalars are WRITE-ONCE (a confirmation does not
 * retract a number it already reported); `items` is APPEND-only. A class becomes "settled":
 *   - amount/recurring: as soon as a value is seen (write-once), or when the stream completes;
 *   - addon/sent: only when explicitly `closes`-d (more line items / a later "sent" line can still
 *     arrive), or when the stream completes.
 */
export interface ReconcileIncrement {
  /** Newly-observed pieces of the user's authorization (the contract). Usually all arrive up front. */
  authorized?: Partial<Authorization>;
  /** Declare the authorization contract fully reported (no more authorization fields will arrive). */
  authFinal?: boolean;
  /** Newly-observed claim fields (used by the LLM residual, not the deterministic rules). */
  claim?: Partial<Pick<AgentClaim, "agent" | "task" | "text">>;
  /** Newly-observed evidence fields. Scalars write-once; items append. */
  evidence?: Partial<MerchantEvidence>;
  /** Evidence classes now fully reported (no further values of this class will arrive). */
  closes?: InfoClass[];
  /** Terminal increment — closes everything (the stream is complete). */
  final?: boolean;
}

export interface ReconcileState {
  /** The materialized full DiffInput so far (unknown evidence ← NEUTRAL defaults). */
  input: DiffInput;
  /** Write-once scalar classes observed at least once. */
  seen: Set<InfoClass>;
  /** Classes explicitly declared fully reported. */
  closed: Set<InfoClass>;
  /** The authorization contract is fully reported. */
  authSettled: boolean;
  /** The stream has ended. */
  streamComplete: boolean;
}

const NEUTRAL_EVIDENCE: MerchantEvidence = {
  source: "agent-report",
  merchant: "",
  amountUsd: null,
  date: null,
  items: [],
  recurring: false,
  excerpt: "",
};
const NEUTRAL_CLAIM: AgentClaim = { agent: "", task: "", text: "", authorized: {} };

export function initialState(): ReconcileState {
  return {
    input: { claim: structuredClone(NEUTRAL_CLAIM), evidence: structuredClone(NEUTRAL_EVIDENCE) },
    seen: new Set(),
    closed: new Set(),
    authSettled: false,
    streamComplete: false,
  };
}

/** Fold one increment into the state (pure — returns a new state). */
export function applyIncrement(s: ReconcileState, inc: ReconcileIncrement): ReconcileState {
  const claim: AgentClaim = { ...s.input.claim, authorized: { ...s.input.claim.authorized } };
  const ev: MerchantEvidence = { ...s.input.evidence, items: [...s.input.evidence.items] };
  const seen = new Set(s.seen);
  const closed = new Set(s.closed);

  if (inc.claim) Object.assign(claim, inc.claim);
  if (inc.authorized) claim.authorized = { ...claim.authorized, ...inc.authorized };

  const e = inc.evidence;
  if (e) {
    if (e.source !== undefined) ev.source = e.source;
    if (e.merchant !== undefined) ev.merchant = e.merchant;
    if (e.date !== undefined) ev.date = e.date;
    if (e.excerpt !== undefined) ev.excerpt = e.excerpt;
    // write-once flip-capable scalars → mark seen
    if (e.amountUsd !== undefined) {
      ev.amountUsd = e.amountUsd;
      seen.add("amount");
    }
    if (e.recurring !== undefined) {
      ev.recurring = e.recurring;
      seen.add("recurring");
    }
    if (e.recurringPeriod !== undefined) ev.recurringPeriod = e.recurringPeriod;
    // items append (addon/sent only settle on explicit close / stream end, never merely on first sight)
    if (e.items !== undefined && e.items.length) ev.items = [...ev.items, ...e.items];
  }

  for (const c of inc.closes ?? []) closed.add(c);
  const authSettled = s.authSettled || Boolean(inc.authFinal) || Boolean(inc.final);
  const streamComplete = s.streamComplete || Boolean(inc.final);

  return { input: { claim, evidence: ev }, seen, closed, authSettled, streamComplete };
}

/** True iff this evidence class can no longer change (so it cannot move the verdict). */
export function settled(s: ReconcileState, c: InfoClass): boolean {
  if (s.streamComplete) return true;
  if (c === "amount" || c === "recurring") return s.seen.has(c);
  return s.closed.has(c); // addon / sent are derived from append-only items+excerpt
}

// ── the dominance / information-completeness check ──────────────────────────────────────────────

type Extreme = "incriminating" | "exculpating";

/** The largest plausible charge — engineered to be over ANY positive budget and into the
 *  critical-severity band, so it triggers every money-keyed rule that could ever fire. */
function bigAmount(input: DiffInput, override?: number): number {
  if (typeof override === "number") return override;
  const b = input.claim.authorized?.budgetUsd;
  return typeof b === "number" && b > 0 ? b * 100 + 1_000_000 : 1_000_000_000;
}

/** Materialize one unsettled class at its worst-case incriminating / exculpating value. */
function applyExtreme(input: DiffInput, c: InfoClass, x: Extreme, opts: { bigAmount?: number }): DiffInput {
  const ev: MerchantEvidence = { ...input.evidence, items: [...input.evidence.items] };
  const out: DiffInput = { ...input, evidence: ev };
  switch (c) {
    case "amount":
      ev.amountUsd = x === "incriminating" ? bigAmount(input, opts.bigAmount) : 0;
      break;
    case "recurring":
      if (x === "incriminating") {
        ev.recurring = true;
        ev.recurringPeriod = "monthly";
      } else {
        ev.recurring = false;
        ev.recurringPeriod = undefined;
      }
      break;
    case "addon":
      // incriminating: an unrequested up-sell product arrives. exculpating: none arrives (no-op).
      if (x === "incriminating") ev.items = [...ev.items, "Trip insurance"];
      break;
    case "sent":
      // incriminating: a "sent/delivered" line appears (fires SCOPE_CREEP only if a prohibition is
      // in scope; otherwise a harmless no-op). exculpating: no such line (no-op).
      if (x === "incriminating") {
        ev.excerpt = `${ev.excerpt} — the message was sent.`.trim();
        ev.items = [...ev.items, "Confirmation email sent"];
      }
      break;
  }
  return out;
}

/**
 * INFORMATION-COMPLETE: no still-unsettled evidence class — pushed to its incriminating OR
 * exculpating extreme, in every combination — can flip the current class to the opposite class.
 * When true, committing the current class is MONOTONE-SAFE: any real future lies between the
 * extremes we tested, so it cannot flip the class either. (Soundness rests on each deterministic
 * rule being monotone in the field its class keys on; the RECON-MR fuzzer is the empirical check.)
 */
export function informationComplete(s: ReconcileState, opts: { bigAmount?: number } = {}): boolean {
  // An unknown authorization can move anything — wait until the contract is settled.
  if (!s.authSettled && !s.streamComplete) return false;

  const cur = classify(diff(s.input));
  const unsettled = INFO_CLASSES.filter((c) => !settled(s, c));
  if (unsettled.length === 0) return true;

  // Enumerate the 2^|unsettled| corner futures; if every corner stays in `cur`, no real future flips.
  const corners = 1 << unsettled.length;
  for (let mask = 0; mask < corners; mask++) {
    let probe = s.input;
    for (let i = 0; i < unsettled.length; i++) {
      const x: Extreme = (mask >> i) & 1 ? "incriminating" : "exculpating";
      probe = applyExtreme(probe, unsettled[i], x, opts);
    }
    if (classify(diff(probe)) !== cur) return false;
  }
  return true;
}

// ── per-prefix decision + the streaming driver ──────────────────────────────────────────────────

export type CommitReason = "information-complete" | "k-stable" | "stream-complete" | "waiting";

export interface StepDecision {
  step: number;
  verdict: Verdict;
  verdictClass: VerdictClass;
  /** Dominance held at this prefix (monotone-safe to commit). */
  infoComplete: boolean;
  /** The class was identical across the last k increments. */
  kStable: boolean;
  streamComplete: boolean;
  /** The active policy would commit at this prefix. */
  commitEligible: boolean;
  /** This is the FIRST prefix the policy committed (the early-commit point). */
  committed: boolean;
  reason: CommitReason;
}

export interface ReconcileOptions {
  /** "safe" (default): commit only when information-complete (or the stream ends). "stable-k": also
   *  commit on k-stability — earlier, but NOT monotone-safe. */
  policy?: "safe" | "stable-k";
  /** Window for k-stability (policy "stable-k"). Default 2. */
  k?: number;
  /** Override the incriminating-amount extreme used by the dominance check (mostly for tests). */
  bigAmount?: number;
}

export interface ReconcileRun {
  steps: StepDecision[];
  /** Index of the first committed prefix, or null if never committed (only possible with no `final`). */
  commitAt: number | null;
  committedClass: VerdictClass | null;
  committedReason: CommitReason | null;
  /** True iff the commit happened strictly before the stream's last increment (a genuine EARLY commit). */
  committedEarly: boolean;
  finalClass: VerdictClass;
  finalVerdict: Verdict;
  /** True iff every prefix at/after the commit kept the committed class (the RECON-MR obligation). */
  heldToEnd: boolean;
}

/**
 * Reconcile a stream of increments, deciding at each prefix whether to commit. Returns the full
 * per-step trace plus the early-commit summary. Pure and deterministic.
 */
export function reconcileStream(increments: ReconcileIncrement[], opts: ReconcileOptions = {}): ReconcileRun {
  const policy = opts.policy ?? "safe";
  const k = Math.max(1, opts.k ?? 2);

  let state = initialState();
  const history: VerdictClass[] = [];
  const steps: StepDecision[] = [];
  let commitAt: number | null = null;
  let committedClass: VerdictClass | null = null;
  let committedReason: CommitReason | null = null;

  increments.forEach((inc, idx) => {
    state = applyIncrement(state, inc);
    const verdict = diff(state.input);
    const verdictClass = classify(verdict);
    history.push(verdictClass);

    const infoComplete = informationComplete(state, { bigAmount: opts.bigAmount });
    const kStable = history.length >= k && history.slice(-k).every((c) => c === verdictClass);
    const streamComplete = state.streamComplete;

    const commitEligible =
      policy === "safe" ? infoComplete || streamComplete : infoComplete || kStable || streamComplete;
    const committed = commitEligible && commitAt === null;

    let reason: CommitReason = "waiting";
    if (commitEligible) {
      reason = infoComplete
        ? "information-complete"
        : policy === "stable-k" && kStable && !streamComplete
          ? "k-stable"
          : "stream-complete";
    }

    if (committed) {
      commitAt = idx;
      committedClass = verdictClass;
      committedReason = reason;
    }

    steps.push({
      step: idx,
      verdict,
      verdictClass,
      infoComplete,
      kStable,
      streamComplete,
      commitEligible,
      committed,
      reason,
    });
  });

  const finalVerdict = steps.length ? steps[steps.length - 1].verdict : diff(state.input);
  const finalClass = classify(finalVerdict);
  const heldToEnd =
    commitAt === null ? true : steps.slice(commitAt).every((st) => st.verdictClass === committedClass);
  const committedEarly = commitAt !== null && commitAt < steps.length - 1;

  return {
    steps,
    commitAt,
    committedClass,
    committedReason,
    committedEarly,
    finalClass,
    finalVerdict,
    heldToEnd,
  };
}

/**
 * Explode a COMPLETE DiffInput into a plausible arrival STREAM, for testing/fuzzing the reconciler:
 *   step 0 — the authorization contract (authFinal) + the PR/email header (merchant, source, date,
 *            recurring known-or-false), no flip-capable evidence revealed yet;
 *   then    — one increment per evidence group (amount; recurring; items+excerpt, which closes
 *            addon & sent), in `order` or shuffled by `rng` (default amount→recurring→items);
 *   last    — a terminal `final` increment (stream complete).
 *
 * Reveal order is fuzzed so RECON-MR sees many arrival sequences, not just one.
 */
export function streamFromDiffInput(
  input: DiffInput,
  opts: { order?: InfoClass[]; rng?: () => number } = {},
): ReconcileIncrement[] {
  const { claim, evidence } = input;
  const base: ReconcileIncrement = {
    authorized: { ...claim.authorized },
    authFinal: true,
    claim: { agent: claim.agent, task: claim.task, text: claim.text },
    evidence: { source: evidence.source, merchant: evidence.merchant, date: evidence.date, excerpt: "" },
  };

  type Group = "amount" | "recurring" | "items";
  const groups: Record<Group, ReconcileIncrement> = {
    amount: { evidence: { amountUsd: evidence.amountUsd } },
    recurring: { evidence: { recurring: evidence.recurring, recurringPeriod: evidence.recurringPeriod } },
    items: { evidence: { items: evidence.items, excerpt: evidence.excerpt }, closes: ["addon", "sent"] },
  };

  const allGroups: Group[] = ["amount", "recurring", "items"];
  let order: Group[];
  if (opts.order) {
    const seen = new Set<Group>();
    order = [];
    for (const c of opts.order) {
      const g: Group = c === "addon" || c === "sent" ? "items" : c;
      if (!seen.has(g)) {
        seen.add(g);
        order.push(g);
      }
    }
    for (const g of allGroups) if (!seen.has(g)) order.push(g);
  } else if (opts.rng) {
    order = shuffle(allGroups, opts.rng);
  } else {
    order = allGroups;
  }

  return [base, ...order.map((g) => groups[g]), { final: true }];
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
