/**
 * Pacioli — Steward + PRE-ACT governor gate (OFFLINE, in-process fake gate).
 *
 * Proves the integration's defining property: a call the governor DENIES is NEVER executed — there is
 * no charge to remediate, unlike the post-act reconcile path which charges then cancels. The gate is a
 * plain in-process fake here (no subprocess); the REAL round trip that spawns Plimsoll is the runnable
 * demo, agent/governor-demo.ts.
 */
import { describe, it, expect } from "vitest";
import { createMockCommerceClient, type MockCommerceClient } from "./tools";
import { runSteward, scriptedStewardModel, subscribeUnderBudget } from "./loop";
import type { GovernorGate, ProposedToolCall } from "./governor";

/** A deterministic in-process gate: deny any call whose estimated cost exceeds `maxUsd`. */
function budgetGate(maxUsd: number): GovernorGate {
  return {
    async check(call: ProposedToolCall) {
      const cost = call.estimated_cost_usd ?? 0;
      return cost > maxUsd
        ? { outcome: "block" as const, allowed: false, blockingRules: ["max_estimated_cost_usd"], reason: `over $${maxUsd}` }
        : { outcome: "allow" as const, allowed: true, blockingRules: [], reason: "allowed" };
    },
  };
}

/** A gate that is always unavailable and fail-closed (an unknown verdict blocks). */
const failClosedGate: GovernorGate = {
  async check() {
    return { outcome: "unavailable", allowed: false, blockingRules: [], reason: "engine unavailable" };
  },
};

describe("Steward — governor DENIES the over-budget call before it executes", () => {
  it("blocks Premium pre-act (never charged), then finishes balanced on a permitted plan", async () => {
    const client = createMockCommerceClient(); // Basic $8 / Standard $15 / Premium $30
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "priciest" }), // reaches for Premium ($30) first
      client,
      governor: budgetGate(20),
    });

    expect(r.outcome).toBe("completed");
    expect(r.success).toBe(true);

    // Premium was DENIED pre-act: a governor-blocked step with NO charge.
    const blocked = r.trace.find((s) => s.governorBlocked);
    expect(blocked).toBeDefined();
    expect(blocked?.action).toMatchObject({ type: "subscribe", planId: "plan_premium" });
    expect(blocked?.charged).toBeNull();
    expect(blocked?.governorRules).toContain("max_estimated_cost_usd");

    // The final, executed action balanced and is within budget.
    expect(r.trace.at(-1)?.balanced).toBe(true);
    expect(r.finalEvidence?.amountUsd).toBeLessThanOrEqual(20);

    // THE KEY DIFFERENCE vs. the post-act path: Premium was never charged, so there is nothing to
    // cancel — exactly ONE active subscription and ZERO canceled ones.
    const snap = (client as MockCommerceClient).snapshot();
    expect(snap.subscriptions).toHaveLength(1);
    expect(snap.subscriptions[0].status).toBe("active");
    expect(snap.subscriptions.some((s) => s.status === "canceled")).toBe(false);
    expect(snap.netChargedUsd).toBeLessThanOrEqual(20);
  });

  it("escalates and charges NOTHING when the gate (fail-closed, unavailable) blocks every call", async () => {
    const client = createMockCommerceClient();
    const r = await runSteward({
      goal: subscribeUnderBudget(20),
      model: scriptedStewardModel({ preference: "cheapest" }),
      client,
      governor: failClosedGate,
    });

    expect(r.outcome).toBe("escalated");
    expect(r.success).toBe(false);
    // Every plan was gated before execution → no charge ever hit the surface.
    const snap = (client as MockCommerceClient).snapshot();
    expect(snap.subscriptions).toHaveLength(0);
    expect(snap.netChargedUsd).toBe(0);
  });
});
