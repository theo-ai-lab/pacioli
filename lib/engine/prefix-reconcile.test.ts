import { describe, it, expect } from "vitest";
import {
  applyIncrement,
  classify,
  informationComplete,
  initialState,
  opposite,
  reconcileStream,
  settled,
  streamFromDiffInput,
  type ReconcileIncrement,
} from "./prefix-reconcile";
import { diff } from "@pacioli-app/engine";
import type { DiffInput } from "@pacioli-app/engine";

describe("prefix-reconcile — verdict class helpers", () => {
  it("classifies balanced vs flagged and flips opposite", () => {
    expect(classify({ balanced: true, findings: [] })).toBe("balanced");
    expect(classify({ balanced: false, findings: [] })).toBe("flagged");
    expect(opposite("balanced")).toBe("flagged");
    expect(opposite("flagged")).toBe("balanced");
  });
});

describe("prefix-reconcile — increment accumulation", () => {
  it("is write-once for scalars, append-only for items, and tracks settledness", () => {
    let s = initialState();
    expect(s.input.evidence.amountUsd).toBeNull();
    expect(settled(s, "amount")).toBe(false);

    s = applyIncrement(s, {
      authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false },
      authFinal: true,
      evidence: { source: "email", merchant: "United" },
    });
    expect(s.authSettled).toBe(true);
    // amount/recurring not yet observed
    expect(settled(s, "amount")).toBe(false);
    expect(settled(s, "recurring")).toBe(false);
    // addon/sent only settle on explicit close / stream end
    expect(settled(s, "addon")).toBe(false);

    s = applyIncrement(s, { evidence: { amountUsd: 120, items: ["Seat 4A"] } });
    expect(s.input.evidence.amountUsd).toBe(120);
    expect(settled(s, "amount")).toBe(true); // write-once scalar, now seen

    // a later increment does not retract the scalar; items append
    s = applyIncrement(s, { evidence: { items: ["Bag"] }, closes: ["addon", "sent"] });
    expect(s.input.evidence.items).toEqual(["Seat 4A", "Bag"]);
    expect(settled(s, "addon")).toBe(true);
    expect(settled(s, "sent")).toBe(true);
  });

  it("stream completion settles every class", () => {
    let s = initialState();
    s = applyIncrement(s, { authorized: { budgetUsd: 10 }, authFinal: true });
    expect(settled(s, "amount")).toBe(false);
    s = applyIncrement(s, { final: true });
    expect(s.streamComplete).toBe(true);
    for (const c of ["amount", "recurring", "addon", "sent"] as const) expect(settled(s, c)).toBe(true);
  });
});

describe("prefix-reconcile — information-completeness (the monotone-safe early-commit rule)", () => {
  it("withholds a BALANCED commit while a flip-capable class is unsettled (amount could overspend)", () => {
    let s = initialState();
    s = applyIncrement(s, {
      authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false },
      authFinal: true,
      evidence: { source: "email", merchant: "x" },
    });
    // currently balanced, but amount is unknown and budget > 0 → an arriving charge could flip it
    expect(classify(diff(s.input))).toBe("balanced");
    expect(informationComplete(s)).toBe(false);
  });

  it("commits BALANCED once every flip-capable class is settled within budget", () => {
    let s = initialState();
    s = applyIncrement(s, {
      authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false },
      authFinal: true,
      evidence: { source: "email", merchant: "x" },
    });
    s = applyIncrement(s, { evidence: { amountUsd: 100, recurring: false }, closes: ["addon", "sent"] });
    expect(classify(diff(s.input))).toBe("balanced");
    expect(informationComplete(s)).toBe(true);
  });

  it("withholds a FLAGGED commit when an unsettled class could EXCULPATE it (the subtle case)", () => {
    // SCOPE_CREEP(spent when mayPurchase===false) is firing, but recurrence is unknown AND authorized.
    // If the charge turns out recurring, RECUR-DOMINANCE suppresses SCOPE_CREEP and — because mayRecur
    // is true — nothing replaces it, so the class could drop back to balanced. The reconciler must wait.
    let s = initialState();
    s = applyIncrement(s, {
      authorized: { budgetUsd: null, mayPurchase: false, mayRecur: true },
      authFinal: true,
      evidence: { source: "email", merchant: "x" },
    });
    s = applyIncrement(s, { evidence: { amountUsd: 50 } }); // amount seen, recurring still unknown
    expect(classify(diff(s.input))).toBe("flagged");
    expect(informationComplete(s)).toBe(false); // exculpating recurring=true future flips it → wait

    // once recurrence is settled false, the SCOPE_CREEP can no longer be explained away → commit
    const s2 = applyIncrement(s, { evidence: { recurring: false }, closes: ["addon", "sent"] });
    expect(classify(diff(s2.input))).toBe("flagged");
    expect(informationComplete(s2)).toBe(true);
  });

  it("commits a hard OVERSPEND early — a settled over-budget charge cannot be undone by later evidence", () => {
    let s = initialState();
    s = applyIncrement(s, {
      authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false },
      authFinal: true,
      evidence: { source: "email", merchant: "x" },
    });
    s = applyIncrement(s, { evidence: { amountUsd: 900 } }); // 3x budget; recurring/items still open
    expect(classify(diff(s.input))).toBe("flagged");
    expect(informationComplete(s)).toBe(true); // nothing unsettled can remove an overspend
  });
});

describe("prefix-reconcile — reconcileStream early commit (safe policy)", () => {
  const overspend: DiffInput = {
    claim: { agent: "comet", task: "book under $300", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false } },
    evidence: { source: "email", merchant: "United", amountUsd: 600, date: null, items: [], recurring: false, excerpt: "Total $600" },
  };

  it("commits an OVERSPEND at the amount increment — before recurrence/items arrive — and never flips", () => {
    const run = reconcileStream(streamFromDiffInput(overspend, { order: ["amount", "recurring", "addon"] }), {
      policy: "safe",
    });
    expect(run.commitAt).toBe(1); // step 0 = header, step 1 = amount
    expect(run.committedClass).toBe("flagged");
    expect(run.committedReason).toBe("information-complete");
    expect(run.committedEarly).toBe(true);
    expect(run.heldToEnd).toBe(true);
    expect(run.finalClass).toBe("flagged");
  });

  const clean: DiffInput = {
    claim: { agent: "comet", task: "buy widget", text: "bought", authorized: { budgetUsd: 100, mayPurchase: true, mayRecur: false } },
    evidence: { source: "email", merchant: "Shop", amountUsd: 90, date: null, items: ["Widget"], recurring: false, excerpt: "Total $90" },
  };

  it("only commits BALANCED once line items close (cannot clear the books while items still stream)", () => {
    const run = reconcileStream(streamFromDiffInput(clean, { order: ["amount", "recurring", "addon"] }), {
      policy: "safe",
    });
    expect(run.committedClass).toBe("balanced");
    expect(run.committedReason).toBe("information-complete");
    // balanced can only commit after the items group (which closes addon/sent) — not at the amount step
    expect(run.commitAt).toBeGreaterThan(1);
    expect(run.heldToEnd).toBe(true);
  });

  it("always commits by the terminal increment (stream-complete) and never reports a flip", () => {
    // a stream with no `final`-precedent settle still commits at the forced terminal step
    const incs: ReconcileIncrement[] = [
      { authorized: { budgetUsd: 50, mayPurchase: true, mayRecur: false }, authFinal: true, evidence: { merchant: "m" } },
      { evidence: { amountUsd: 10 }, final: true },
    ];
    const run = reconcileStream(incs, { policy: "safe" });
    expect(run.commitAt).not.toBeNull();
    expect(run.heldToEnd).toBe(true);
  });
});

describe("prefix-reconcile — stable-k policy commits sooner (and is explicitly NOT monotone-safe)", () => {
  const flipsLate: DiffInput = {
    claim: { agent: "a", task: "book under $300", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true, mayRecur: false } },
    evidence: { source: "email", merchant: "United", amountUsd: 5000, date: null, items: [], recurring: false, excerpt: "Total $5000" },
  };

  it("k=1 commits BALANCED at step 0 then the verdict flips when the charge arrives (heuristic is unsafe)", () => {
    const run = reconcileStream(streamFromDiffInput(flipsLate, { order: ["amount", "recurring", "addon"] }), {
      policy: "stable-k",
      k: 1,
    });
    expect(run.commitAt).toBe(0);
    expect(run.committedClass).toBe("balanced");
    expect(run.committedReason).toBe("k-stable");
    expect(run.heldToEnd).toBe(false); // it flipped — exactly what RECON-MR forbids for a real commit
    expect(run.finalClass).toBe("flagged");
  });

  it("the SAME case under the safe policy waits and never flips", () => {
    const run = reconcileStream(streamFromDiffInput(flipsLate, { order: ["amount", "recurring", "addon"] }), {
      policy: "safe",
    });
    expect(run.committedClass).toBe("flagged");
    expect(run.heldToEnd).toBe(true);
  });
});
