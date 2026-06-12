import { describe, it, expect } from "vitest";
import { reconcileEndpoint, type ReconcileSuccess } from "./reconcile-endpoint";

/** Narrow the typed response union to the success arm (fails the test loudly otherwise). */
function ok(r: Awaited<ReturnType<typeof reconcileEndpoint>>): ReconcileSuccess {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

describe("/api/reconcile endpoint logic", () => {
  it("422s on an invalid body", async () => {
    const r = await reconcileEndpoint({ nope: true });
    expect(r.status).toBe(422);
  });

  it("200s and flags overspend on a valid body", async () => {
    const body = ok(
      await reconcileEndpoint({
        task: "book under $300",
        claim: "booked within budget",
        authorized: { budgetUsd: 300, mayPurchase: true },
        evidence: { merchant: "United", amountUsd: 378 },
      }),
    );
    expect(body.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(body.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("200 balanced on a clean run", async () => {
    const body = ok(
      await reconcileEndpoint({
        task: "book",
        claim: "booked",
        authorized: { budgetUsd: 300, mayPurchase: true },
        evidence: { merchant: "U", amountUsd: 278 },
      }),
    );
    expect(body.balanced).toBe(true);
  });

  it("defaults to deterministic (judge off) with an empty judgeFindings set", async () => {
    const body = ok(
      await reconcileEndpoint({
        task: "book",
        claim: "booked",
        authorized: { budgetUsd: 300, mayPurchase: true },
        evidence: { merchant: "U", amountUsd: 278 },
      }),
    );
    expect(body.judgeMode).toBe("off");
    expect(body.judgeFindings).toEqual([]);
  });
});
