/**
 * Pacioli — the Steward loop: an agent that COMPLETES a commerce task with reconcile as its conscience.
 *
 * This is a hand-rolled tool-use loop (we own the loop; the model is injected). The model proposes an
 * action; we EXECUTE it against the sandboxed commerce surface; then — the whole point — we reconcile
 * what we CLAIM we did against what the merchant ACTUALLY did using Pacioli's own `diff()` engine
 * (lib/engine/diff.ts), the same deterministic oracle the auditor uses.
 *
 *   • BALANCED      → the action reconciles under the authorization. We finish, with a tamper-evident
 *                     receipt for the action that balanced. This is the ONLY way the loop succeeds.
 *   • OUT_OF_BALANCE → the conscience fired (e.g. OVERSPEND). We ACT: remediate the bad action
 *                     (cancel the over-budget subscription), then loop so the model picks a different,
 *                     in-budget option — feeding it the findings it must correct for.
 *   • no option works → ESCALATE to a human (and a maxSteps safety net escalates a runaway model).
 *
 * The model is INJECTABLE so the loop is deterministically testable with `scriptedStewardModel()` (no
 * key, no network). The live policy is `anthropicStewardModel()` in agent/model-anthropic.ts, which
 * needs ANTHROPIC_API_KEY; the live commerce client needs a Stripe TEST key (see agent/tools.ts).
 */

import { diff } from "../lib/engine/diff";
import { buildReceipt } from "../lib/engine/receipt";
import type { Authorization, DiffInput, FindingType, MerchantEvidence, Verdict } from "../lib/engine/types";
import { cancelSubscription, listPlans, subscribe, type CommerceClient, type Plan } from "./tools";
import type { GovernorGate, ProposedToolCall } from "./governor";

// ── Goal ──────────────────────────────────────────────────────────────────────────────────────────

export interface Goal {
  /** Human-readable objective, e.g. "Subscribe to a plan within a $20/period budget". */
  description: string;
  /** What the user authorized — held against the agent by `diff()` on every step. */
  authorized: Authorization;
}

/** Construct the canonical "subscribe under $X" goal. mayPurchase/mayRecur are TRUE (a subscription is
 *  an authorized recurring purchase), so the only finding that can fire on a sub is OVERSPEND. */
export function subscribeUnderBudget(budgetUsd: number, opts?: { scope?: string }): Goal {
  return {
    description: `Subscribe to a plan within a $${budgetUsd}/period budget`,
    authorized: {
      budgetUsd,
      mayPurchase: true,
      mayRecur: true,
      scope: opts?.scope ?? "subscribe to one plan within budget",
    },
  };
}

// ── The injectable model (policy) ─────────────────────────────────────────────────────────────────

export type StewardAction =
  | { type: "subscribe"; planId: string; rationale?: string }
  | { type: "escalate"; reason: string };

/** One prior attempt, with the in-loop reconcile verdict — the feedback the model self-corrects on. */
export interface Attempt {
  planId: string;
  evidence: MerchantEvidence;
  verdict: Verdict;
}

export interface StewardContext {
  goal: Goal;
  /** The catalog the loop fetched over the seam. */
  plans: Plan[];
  /** Prior attempts and their reconcile verdicts (so the model can avoid ruled-out options). */
  history: Attempt[];
  /** Plan ids the PRE-ACT governor refused before they could run (never charged). A model should treat
   *  these like ruled-out options. Always present (empty when no governor is wired). */
  blockedPlanIds: string[];
}

/** Inject a real LLM policy (anthropicStewardModel) or the deterministic stub (scriptedStewardModel). */
export interface StewardModel {
  decide(ctx: StewardContext): Promise<StewardAction>;
}

// ── Result + trace (the task-success metric + per-step trace) ─────────────────────────────────────

export interface StepTrace {
  step: number;
  action: StewardAction;
  /** What the merchant actually charged on this step (null when no action executed). */
  charged?: number | null;
  /** The in-loop reconcile result for this step's action. */
  balanced?: boolean;
  findingTypes?: FindingType[];
  /** Whether the loop remediated (canceled) an out-of-balance action. */
  remediated?: boolean;
  /** True iff the PRE-ACT governor refused this step — the tool call was NEVER executed (no charge). */
  governorBlocked?: boolean;
  /** Plimsoll rule_ids that blocked the call (when governorBlocked). */
  governorRules?: string[];
  note: string;
}

export interface StewardResult {
  goal: Goal;
  outcome: "completed" | "escalated";
  /** THE task-success metric: true iff the agent finished with a reconciled (balanced) action. */
  success: boolean;
  /** Loop iterations taken. */
  steps: number;
  /** How many times the conscience fired and the agent self-corrected. */
  corrections: number;
  /** Evidence of the action that balanced (null if escalated). */
  finalEvidence: MerchantEvidence | null;
  /** Tamper-evident receipt id for the balanced action (null if escalated). */
  receiptId: string | null;
  escalation: { reason: string } | null;
  trace: StepTrace[];
}

// ── The loop ──────────────────────────────────────────────────────────────────────────────────────

export async function runSteward(opts: {
  goal: Goal;
  model: StewardModel;
  client: CommerceClient;
  /** Safety net: max loop iterations before forced escalation. Defaults to the catalog size + 3. */
  maxSteps?: number;
  /** OPTIONAL pre-act gate (Plimsoll's deterministic governor). Consulted BEFORE each commerce tool
   *  call; on deny the call is NEVER executed — the plan is ruled out and the loop self-corrects to a
   *  permitted option (or escalates). Absent ⇒ prior behavior, no gate. This is the genuine, live
   *  cross-tool integration: a provable deterministic floor under the agent's actions. */
  governor?: GovernorGate;
}): Promise<StewardResult> {
  const { goal, model, client, governor } = opts;
  const trace: StepTrace[] = [];
  const history: Attempt[] = [];
  const attempted = new Set<string>();
  const blockedPlanIds: string[] = [];
  let corrections = 0;

  // Fetch the catalog over the HTTP-shaped seam (one real request).
  const plans = await listPlans(client);
  const maxSteps = opts.maxSteps ?? Math.max(6, plans.length + 3);

  if (plans.length === 0) {
    return escalated(goal, trace, "the commerce surface returned an empty catalog", 0, corrections);
  }

  for (let step = 1; step <= maxSteps; step++) {
    const action = await model.decide({ goal, plans, history, blockedPlanIds });

    // The model can give up directly when it sees no viable option.
    if (action.type === "escalate") {
      trace.push({ step, action, note: `model escalated: ${action.reason}` });
      return escalated(goal, trace, action.reason, step, corrections);
    }

    const plan = plans.find((p) => p.id === action.planId);
    if (!plan) {
      trace.push({ step, action, note: `model chose an unknown plan: ${action.planId}` });
      return escalated(goal, trace, `model chose an unknown plan: ${action.planId}`, step, corrections);
    }

    // No-progress guard: a model that re-proposes a ruled-out plan would loop forever. Escalate.
    if (attempted.has(plan.id)) {
      trace.push({ step, action, note: `model repeated a ruled-out option (${plan.id})` });
      return escalated(goal, trace, `model repeated a ruled-out option (${plan.id}); no progress`, step, corrections);
    }
    attempted.add(plan.id);

    // ── PRE-ACT GOVERNOR GATE: ask Plimsoll's deterministic governor whether this tool call MAY run,
    //    BEFORE any charge. On deny the call is not executed; we rule the plan out and self-correct.
    //    This is the complement to the post-act reconcile conscience below: the governor stops the
    //    knowable-bad call up front; reconcile catches what only the evidence reveals (e.g. drip fees).
    if (governor) {
      const proposed: ProposedToolCall = {
        tool: "subscribe",
        estimated_cost_usd: plan.priceUsd,
        input: { planId: plan.id },
      };
      const decision = await governor.check(proposed);
      if (!decision.allowed) {
        corrections++;
        blockedPlanIds.push(plan.id);
        const why = decision.blockingRules.join(", ") || decision.reason;
        trace.push({
          step,
          action,
          charged: null,
          balanced: false,
          governorBlocked: true,
          governorRules: decision.blockingRules,
          note:
            `GOVERNOR ${decision.outcome === "unavailable" ? "UNAVAILABLE → fail-closed" : "DENIED"} (${why}) — ` +
            `'${plan.name}' ($${plan.priceUsd}/${plan.period}) NOT executed; self-correcting`,
        });
        continue;
      }
    }

    // EXECUTE the action. The idempotency key ties this (plan, step) attempt to a single charge.
    const tool = await subscribe(client, { planId: plan.id, idempotencyKey: `steward:${plan.id}:${step}` });
    if (!tool.ok || !tool.evidence) {
      // A transport/merchant failure is not a reconcile failure — a human should look.
      trace.push({ step, action, note: `commerce error on ${plan.id}: ${tool.error ?? "unknown"}` });
      return escalated(goal, trace, `commerce surface error on ${plan.id}: ${tool.error ?? "unknown"}`, step, corrections);
    }
    const evidence = tool.evidence;

    // ── IN-LOOP CONSCIENCE: reconcile the CLAIM (what we say we did, at sticker price) against the
    //    EVIDENCE (what the merchant actually charged). Same deterministic engine as the auditor.
    const input: DiffInput = {
      claim: {
        agent: "steward",
        task: goal.description,
        text: `Subscribed to ${plan.name} at $${plan.priceUsd}/${plan.period}`,
        authorized: goal.authorized,
      },
      evidence,
    };
    const verdict = diff(input);
    history.push({ planId: plan.id, evidence, verdict });

    if (verdict.balanced) {
      // The books balance — and ONLY now do we finish. Mint the tamper-evident receipt.
      const receipt = await buildReceipt(input);
      trace.push({
        step,
        action,
        charged: evidence.amountUsd,
        balanced: true,
        findingTypes: [],
        note: `BALANCED — ${plan.name} at $${evidence.amountUsd}/${plan.period}; receipt ${receipt.receiptId}`,
      });
      return {
        goal,
        outcome: "completed",
        success: true,
        steps: step,
        corrections,
        finalEvidence: evidence,
        receiptId: receipt.receiptId,
        escalation: null,
        trace,
      };
    }

    // OUT_OF_BALANCE — the conscience fired. ACT: undo the bad charge, then loop for a better option.
    corrections++;
    let remediated = false;
    if (tool.ref) {
      const undo = await cancelSubscription(client, { subscriptionId: tool.ref });
      remediated = undo.ok;
    }
    const types = verdict.findings.map((f) => f.type);
    trace.push({
      step,
      action,
      charged: evidence.amountUsd,
      balanced: false,
      findingTypes: types,
      remediated,
      note:
        `OUT_OF_BALANCE (${types.join(", ")}) — ${verdict.findings[0]?.note ?? "discrepancy"}` +
        `${remediated ? `; canceled ${tool.ref}` : ""}; self-correcting`,
    });
  }

  // Safety net: a model that never balanced and never escalated within the step budget.
  return escalated(goal, trace, `exhausted ${maxSteps} steps without reconciling under budget`, maxSteps, corrections);
}

function escalated(goal: Goal, trace: StepTrace[], reason: string, steps: number, corrections: number): StewardResult {
  return {
    goal,
    outcome: "escalated",
    success: false,
    steps,
    corrections,
    finalEvidence: null,
    receiptId: null,
    escalation: { reason },
    trace,
  };
}

// ── The deterministic stub model (used by tests + the offline demo) ───────────────────────────────

/**
 * A no-network policy that proves the loop. It picks the most-preferred plan NOT yet ruled out by a
 * prior reconcile verdict; when reconcile has ruled them all out, it escalates. Crucially it learns a
 * plan is over budget ONLY from the loop's reconcile feedback (history) — so reconcile is provably the
 * thing that catches the overspend. `preference: "priciest"` models an over-reaching agent (reaches
 * for the best plan first), which is how we inject a first-action overspend deterministically.
 */
export function scriptedStewardModel(opts?: { preference?: "cheapest" | "priciest" }): StewardModel {
  const pref = opts?.preference ?? "cheapest";
  return {
    async decide({ goal, plans, history, blockedPlanIds }: StewardContext): Promise<StewardAction> {
      // Rule out plans the reconcile conscience flagged AND plans the pre-act governor refused —
      // both are real feedback the agent must not ignore.
      const ruledOut = new Set(history.filter((a) => !a.verdict.balanced).map((a) => a.planId));
      for (const id of blockedPlanIds) ruledOut.add(id);
      const candidates = plans
        .filter((p) => !ruledOut.has(p.id))
        .sort((a, b) => (pref === "cheapest" ? a.priceUsd - b.priceUsd : b.priceUsd - a.priceUsd));
      if (candidates.length === 0) {
        const gated = blockedPlanIds.length ? " / blocked by the governor" : "";
        return {
          type: "escalate",
          reason: `every plan was ruled out by reconcile${gated} under the $${goal.authorized.budgetUsd} budget`,
        };
      }
      return { type: "subscribe", planId: candidates[0].id, rationale: `${pref} remaining plan` };
    },
  };
}
