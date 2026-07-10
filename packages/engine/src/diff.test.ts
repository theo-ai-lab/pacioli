import { describe, it, expect } from "vitest";
import { diff } from "./diff";
import type { AgentClaim, Authorization, MerchantEvidence } from "./types";

const claim = (authorized: Authorization): AgentClaim => ({
  agent: "test-agent",
  task: "test task",
  text: "test claim",
  authorized,
});

const evid = (e: Partial<MerchantEvidence>): MerchantEvidence => ({
  source: "pasted",
  merchant: "merchant",
  amountUsd: null,
  date: null,
  items: [],
  recurring: false,
  excerpt: "",
  ...e,
});

const run = (a: Authorization, e: Partial<MerchantEvidence>) => diff({ claim: claim(a), evidence: evid(e) });
const typesOf = (v: ReturnType<typeof diff>) => v.findings.map((f) => f.type);

describe("OVERSPEND", () => {
  it("fires when charged over budget beyond tolerance", () => {
    const v = run({ budgetUsd: 300, mayPurchase: true }, { amountUsd: 378 });
    expect(typesOf(v)).toContain("OVERSPEND");
    expect(v.balanced).toBe(false);
  });

  it("does NOT fire within the 2% tolerance", () => {
    const v = run({ budgetUsd: 300, mayPurchase: true }, { amountUsd: 304 });
    expect(v.balanced).toBe(true);
  });

  it("does NOT fire below the absolute dollar floor", () => {
    // 10.50 vs 10 is >2% over the ceiling (10.20) but the $0.50 delta is below the $1 floor
    const v = run({ budgetUsd: 10, mayPurchase: true }, { amountUsd: 10.5 });
    expect(typesOf(v)).not.toContain("OVERSPEND");
  });

  it("does NOT fire on a $0 / no-spend authorization (that is UNAUTH/SCOPE)", () => {
    const v = run({ budgetUsd: 0, mayPurchase: false }, { amountUsd: 14.99, recurring: true, recurringPeriod: "monthly" });
    expect(typesOf(v)).not.toContain("OVERSPEND");
    expect(typesOf(v)).toContain("UNAUTH_RECURRENCE");
  });

  it("scales severity by how far over budget", () => {
    expect(run({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 250 }).findings[0].severity).toBe("high"); // +150 (>25%)
    expect(run({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 120 }).findings[0].severity).toBe("medium"); // +20 (>10%)
    expect(run({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 108 }).findings[0].severity).toBe("low"); // +8
  });
});

describe("UNAUTH_RECURRENCE", () => {
  it("fires on an unauthorized recurring charge", () => {
    const v = run({ mayRecur: false }, { amountUsd: 9.99, recurring: true, recurringPeriod: "monthly" });
    expect(typesOf(v)).toContain("UNAUTH_RECURRENCE");
    expect(v.findings[0].severity).toBe("critical");
  });

  it("does NOT fire when recurrence was authorized", () => {
    const v = run({ mayRecur: true, mayPurchase: true, budgetUsd: 20 }, { amountUsd: 9.99, recurring: true });
    expect(typesOf(v)).not.toContain("UNAUTH_RECURRENCE");
  });
});

describe("SCOPE_CREEP", () => {
  it("fires when money is spent without purchase authorization", () => {
    const v = run({ mayPurchase: false }, { amountUsd: 329 });
    expect(typesOf(v)).toContain("SCOPE_CREEP");
  });

  it("does NOT double-count a free-trial recurrence as SCOPE_CREEP too", () => {
    const v = run({ mayPurchase: false }, { amountUsd: 14.99, recurring: true, recurringPeriod: "monthly" });
    expect(typesOf(v)).toContain("UNAUTH_RECURRENCE");
    expect(typesOf(v)).not.toContain("SCOPE_CREEP");
  });

  it("fires on an unrequested up-sell product (insurance) the user never asked for", () => {
    const v = run(
      { budgetUsd: 300, mayPurchase: true, scope: "book one flight" },
      { amountUsd: 378, items: ["UA1542 nonstop", "Trip insurance"] },
    );
    expect(typesOf(v)).toContain("SCOPE_CREEP");
  });

  it("does NOT flag an add-on the user actually asked for", () => {
    const v = run(
      { mayPurchase: true, scope: "book flight with trip insurance" },
      { amountUsd: 50, items: ["Trip insurance"] },
    );
    expect(typesOf(v)).not.toContain("SCOPE_CREEP");
  });

  it("fires when a 'do not send' / draft-only constraint is violated (even at $0)", () => {
    const v = run(
      { mayPurchase: false, scope: "draft only", constraints: ["do not send"] },
      { amountUsd: 0, items: ["Sent: Re: Lease renewal to landlord@example"], excerpt: "Message sent at 2:14 PM" },
    );
    expect(typesOf(v)).toContain("SCOPE_CREEP");
  });
});

describe("CLAIM_MISMATCH residual", () => {
  it("ABSTAINS on a pure wording mismatch with matching numbers (routed to the LLM judge)", () => {
    // Claim says 'cheapest nonstop'; numbers/budget all reconcile. A deterministic rule
    // cannot prove a cheaper flight existed, so the engine balances rather than guess.
    const v = run({ budgetUsd: 300, mayPurchase: true, constraints: ["cheapest", "nonstop"] }, { amountUsd: 278 });
    expect(v.balanced).toBe(true);
    expect(typesOf(v)).not.toContain("CLAIM_MISMATCH");
  });
});

describe("invariants", () => {
  it("a clean run balances with zero findings", () => {
    const v = run({ budgetUsd: 300, mayPurchase: true }, { amountUsd: 278 });
    expect(v.balanced).toBe(true);
    expect(v.findings).toHaveLength(0);
  });

  it("every finding cites both a claim line and an evidence line (citation invariant)", () => {
    const v = run({ budgetUsd: 100, mayPurchase: true }, { amountUsd: 250 });
    expect(v.findings.length).toBeGreaterThan(0);
    for (const f of v.findings) {
      expect(f.claimedRef.length).toBeGreaterThan(0);
      expect(f.actualRef.length).toBeGreaterThan(0);
      expect(f.note.length).toBeGreaterThan(0);
      expect(f.llmAssisted).toBe(false); // deterministic rules are never llm-assisted
    }
  });

  it("computes net delta vs the authorized budget (+ = over)", () => {
    expect(run({ budgetUsd: 300, mayPurchase: true }, { amountUsd: 378 }).deltaUsd).toBe(78);
  });

  it("treats a no-budget authorization as a $0 base for the delta", () => {
    expect(run({ mayPurchase: false }, { amountUsd: 14.99 }).deltaUsd).toBe(14.99);
  });

  it("leaves delta undefined when no amount is known", () => {
    expect(run({ budgetUsd: 300, mayPurchase: true }, { amountUsd: null }).deltaUsd).toBeUndefined();
  });
});
