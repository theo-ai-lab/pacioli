/**
 * Pacioli — Steward loop tests. Proves the agent COMPLETES the task and uses reconcile as its
 * conscience. No API key, no network: the deterministic stub policy (scriptedStewardModel) drives the
 * in-memory mock commerce surface (createMockCommerceClient).
 */
import { describe, it, expect } from "vitest";
import { createMockCommerceClient, type MockCommerceClient, type Plan } from "./tools";
import { runSteward, scriptedStewardModel, subscribeUnderBudget, type StewardModel } from "./loop";

describe("Steward — completes a clean task", () => {
  it("finishes balanced on the first action, with a receipt and zero corrections", async () => {
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "cheapest" }),
      client: createMockCommerceClient(),
    });

    expect(r.outcome).toBe("completed");
    expect(r.success).toBe(true);
    expect(r.corrections).toBe(0);
    expect(r.steps).toBe(1);
    expect(r.receiptId).toMatch(/^sha256:/);
    expect(r.finalEvidence?.amountUsd).toBeLessThanOrEqual(20);
    // exactly one action, and it BALANCED
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0].balanced).toBe(true);
  });
});

describe("Steward — self-corrects via reconcile, then finishes balanced", () => {
  it("over-reaches, gets caught by OVERSPEND, cancels, and steps down under budget", async () => {
    const client = createMockCommerceClient(); // Basic $8 / Standard $15 / Premium $30
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "priciest" }), // reaches for Premium first
      client,
    });

    // It finished, and it finished BALANCED — the only way success is true.
    expect(r.outcome).toBe("completed");
    expect(r.success).toBe(true);

    // The conscience fired at least once and drove a self-correction.
    expect(r.corrections).toBeGreaterThanOrEqual(1);
    const overspendStep = r.trace.find((s) => s.balanced === false);
    expect(overspendStep).toBeDefined();
    expect(overspendStep?.findingTypes).toContain("OVERSPEND");
    expect(overspendStep?.remediated).toBe(true); // the over-budget sub was canceled

    // The final, balanced charge is within budget.
    expect(r.finalEvidence?.amountUsd).toBeLessThanOrEqual(20);
    expect(r.trace.at(-1)?.balanced).toBe(true);

    // Remediation really happened on the surface: exactly one ACTIVE subscription, the over-budget
    // one canceled, and no double-charge (net charge is the in-budget plan only).
    const snap = (client as MockCommerceClient).snapshot();
    expect(snap.subscriptions.filter((s) => s.status === "active")).toHaveLength(1);
    expect(snap.subscriptions.some((s) => s.status === "canceled")).toBe(true);
    expect(snap.netChargedUsd).toBeLessThanOrEqual(20);
  });

  it("catches merchant-side drip pricing (a hidden fee) the sticker price hid, then corrects", async () => {
    // Two plans; a $6 hidden fee makes Standard's ACTUAL charge $21 (> $20) even though it looked fine.
    const plans: Plan[] = [
      { id: "plan_basic", name: "Basic", priceUsd: 8, recurring: true, period: "monthly" },
      { id: "plan_standard", name: "Standard", priceUsd: 15, recurring: true, period: "monthly" },
    ];
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "priciest" }), // tries Standard ($15 sticker) first
      client: createMockCommerceClient({ plans, surchargeUsd: 6 }),
    });

    expect(r.success).toBe(true);
    expect(r.corrections).toBe(1); // Standard overspent (actual $21), Basic ($14 actual) balanced
    const caught = r.trace.find((s) => s.balanced === false);
    expect(caught?.findingTypes).toContain("OVERSPEND");
    expect(caught?.charged).toBe(21); // reconcile saw the ACTUAL charge, not the $15 sticker
    expect(r.finalEvidence?.amountUsd).toBe(14); // Basic $8 + $6 fee, within budget
  });
});

describe("Steward — escalates when it cannot reconcile", () => {
  it("escalates instead of overspending when no plan fits the budget", async () => {
    const client = createMockCommerceClient(); // cheapest plan is $8
    const r = await runSteward({
      goal: subscribeUnderBudget(5), // nothing fits
      model: scriptedStewardModel({ preference: "cheapest" }),
      client,
    });

    expect(r.outcome).toBe("escalated");
    expect(r.success).toBe(false);
    expect(r.receiptId).toBeNull();
    expect(r.escalation?.reason).toMatch(/ruled out|budget/i);
    // It tried every plan (each caught by reconcile) before giving up.
    expect(r.corrections).toBe(3);
    // And it left nothing charged: every attempted subscription was canceled on remediation.
    const snap = (client as MockCommerceClient).snapshot();
    expect(snap.subscriptions.every((s) => s.status === "canceled")).toBe(true);
    expect(snap.netChargedUsd).toBe(0);
  });
});

describe("Steward — loop safety", () => {
  it("escalates on a runaway model that never balances, bounded by maxSteps", async () => {
    // A pathological policy that always proposes the same (over-budget) plan: the loop's no-progress
    // guard must escalate rather than spin forever.
    const stuck: StewardModel = {
      async decide() {
        return { type: "subscribe", planId: "plan_premium" };
      },
    };
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: stuck,
      client: createMockCommerceClient(),
      maxSteps: 25,
    });
    expect(r.outcome).toBe("escalated");
    expect(r.success).toBe(false);
    expect(r.steps).toBeLessThan(25); // stopped early by the repeat/no-progress guard, not the cap
  });
});
