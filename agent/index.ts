/**
 * Pacioli — Steward: the runnable demo + public exports.
 *
 * Steward is Pacioli's second role. The rest of the repo is the AUDITOR (judge a finished run after the
 * fact). Steward is the AGENT ENGINEER's role: an agent that COMPLETES a real multi-step commerce task
 * and uses Pacioli's own `diff()` reconcile as its in-loop conscience — catching its own overspend
 * before it reports success, instead of being caught afterward.
 *
 * `npm run steward` / `npm run steward:demo` runs this OFFLINE: the deterministic stub policy
 * (scriptedStewardModel) against the in-memory mock commerce surface (createMockCommerceClient). No
 * API key, no network, no install. It walks four scenarios:
 *   1. clean        — the first choice reconciles; the agent finishes balanced.
 *   2. self-correct — the agent over-reaches (picks the priciest plan), reconcile catches the
 *                     OVERSPEND, the agent cancels and steps down to an in-budget plan.
 *   3. drip-pricing — a merchant-side hidden fee pushes a sticker-OK plan over budget; reconcile
 *                     catches the ACTUAL charge and the agent corrects (the gap the mock can't fake
 *                     away and the model can't predict from the sticker).
 *   4. escalate     — no plan fits the budget; the agent escalates instead of overspending.
 *
 * LIVE PATH (not exercised here): swap in anthropicStewardModel() (needs ANTHROPIC_API_KEY) and
 * createStripeTestClient() (needs a Stripe TEST key, sk_test_…). Even with both, a real END USER
 * actually consenting to the charge is the un-fakeable gap beyond any harness.
 */

export * from "./tools";
export * from "./loop";
export { anthropicStewardModel, stewardModelEnabled, STEWARD_MODEL } from "./model-anthropic";

import { createMockCommerceClient } from "./tools";
import { runSteward, scriptedStewardModel, subscribeUnderBudget, type StewardResult } from "./loop";

function render(title: string, r: StewardResult): void {
  console.log(`\n=== ${title} ===`);
  console.log(`goal: ${r.goal.description}`);
  for (const s of r.trace) {
    const tag = s.balanced === true ? "✅" : s.balanced === false ? "⚠️ " : "··";
    console.log(`  ${tag} step ${s.step}: ${s.note}`);
  }
  console.log(
    `outcome=${r.outcome} success=${r.success} steps=${r.steps} corrections=${r.corrections}` +
      (r.receiptId ? ` receipt=${r.receiptId}` : "") +
      (r.escalation ? ` escalation="${r.escalation.reason}"` : ""),
  );
}

async function main(): Promise<void> {
  console.log("Steward — Pacioli's reconcile as an agent's in-loop conscience (offline demo).");

  // 1. Clean: budget comfortably fits the cheapest plan; the well-behaved agent finishes first try.
  render(
    "1. clean task",
    await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "cheapest" }),
      client: createMockCommerceClient(),
    }),
  );

  // 2. Self-correct: an over-reaching agent (priciest-first) picks Premium ($30) over a $20 budget;
  //    reconcile catches the OVERSPEND, the loop cancels it, the agent steps down to Standard ($15).
  render(
    "2. self-correct on overspend",
    await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "priciest" }),
      client: createMockCommerceClient(),
    }),
  );

  // 3. Merchant-side drip pricing: a $6 hidden fee pushes Standard ($15→$21) over a $20 budget even
  //    though the sticker looked fine. Reconcile sees the ACTUAL charge and the agent drops to Basic.
  render(
    "3. caught merchant drip-pricing",
    await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "priciest" }),
      client: createMockCommerceClient({ surchargeUsd: 6 }),
    }),
  );

  // 4. Escalate: a $5 budget no plan can meet. The agent escalates rather than overspend.
  render(
    "4. escalate when impossible",
    await runSteward({
      goal: subscribeUnderBudget(5),
      model: scriptedStewardModel({ preference: "cheapest" }),
      client: createMockCommerceClient(),
    }),
  );

  console.log(
    "\nLive path: anthropicStewardModel() needs ANTHROPIC_API_KEY; createStripeTestClient() needs a" +
      " Stripe TEST key (sk_test_…). A real end user consenting to the charge is the un-fakeable gap.",
  );
}

// Run only when invoked directly (tsx agent/index.ts), never on import.
const invokedDirectly =
  typeof process !== "undefined" && Array.isArray(process.argv) && /agent[/\\]index\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
