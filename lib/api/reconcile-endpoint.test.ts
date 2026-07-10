import { describe, it, expect } from "vitest";
import {
  classifyClaim,
  reconcileBatch,
  reconcileEndpoint,
  type ReconcileBatchSuccess,
  type ReconcileSuccess,
} from "./reconcile-endpoint";
import type { Finding, FindingType } from "@pacioli-app/engine";

/** Narrow the typed response union to the success arm (fails the test loudly otherwise). */
function ok(r: Awaited<ReturnType<typeof reconcileEndpoint>>): ReconcileSuccess {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

function okBatch(r: Awaited<ReturnType<typeof reconcileBatch>>): ReconcileBatchSuccess {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

const finding = (type: FindingType, llmAssisted = false): Finding => ({
  type,
  dimension: "money",
  severity: "high",
  claimedRef: "c",
  actualRef: "a",
  llmAssisted,
  note: "n",
});

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

describe("classifyClaim — deterministic-first supported/unsupported/overclaim", () => {
  it("supported when there are no findings", () => {
    expect(classifyClaim([])).toBe("supported");
  });

  it("overclaim on any deterministic over-reach finding", () => {
    expect(classifyClaim([finding("OVERSPEND")])).toBe("overclaim");
    expect(classifyClaim([finding("SCOPE_CREEP")])).toBe("overclaim");
    expect(classifyClaim([finding("UNAUTH_RECURRENCE")])).toBe("overclaim");
  });

  it("unsupported when only a CLAIM_MISMATCH (the judge residual) remains", () => {
    expect(classifyClaim([finding("CLAIM_MISMATCH", true)])).toBe("unsupported");
  });

  it("overclaim takes precedence over a co-occurring CLAIM_MISMATCH (the deterministic floor wins)", () => {
    expect(classifyClaim([finding("CLAIM_MISMATCH", true), finding("OVERSPEND")])).toBe("overclaim");
  });
});

describe("reconcileBatch — N claims against one shared evidence", () => {
  it("422s when claims is empty", async () => {
    const r = await reconcileBatch({ claims: [], evidence: { merchant: "U", amountUsd: 378 } });
    expect(r.status).toBe(422);
  });

  it("returns a per-claim supported/overclaim verdict + a summary, echoing ids", async () => {
    const body = okBatch(
      await reconcileBatch({
        claims: [
          { id: "tight", task: "book under $300", claim: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
          { id: "loose", task: "book under $500", claim: "booked", authorized: { budgetUsd: 500, mayPurchase: true } },
        ],
        evidence: { merchant: "United", amountUsd: 378 },
      }),
    );

    expect(body.merchant).toBe("United");
    expect(body.judgeMode).toBe("off");
    expect(body.claims.map((c) => c.id)).toEqual(["tight", "loose"]);

    const tight = body.claims.find((c) => c.id === "tight")!;
    expect(tight.status).toBe("overclaim"); // 378 > 300 → OVERSPEND
    expect(tight.balanced).toBe(false);
    expect(tight.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(tight.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);

    const loose = body.claims.find((c) => c.id === "loose")!;
    expect(loose.status).toBe("supported"); // 378 < 500 → balanced
    expect(loose.balanced).toBe(true);

    expect(body.summary).toEqual({ total: 2, supported: 1, unsupported: 0, overclaim: 1 });
  });

  it("falls back to the 0-based index when a claim omits its id", async () => {
    const body = okBatch(
      await reconcileBatch({
        claims: [{ task: "t", claim: "c", authorized: { budgetUsd: 500, mayPurchase: true } }],
        evidence: { merchant: "U", amountUsd: 10 },
      }),
    );
    expect(body.claims[0].id).toBe("0");
  });

  it("reports judgeMode 'unauthorized' when a judge is requested without auth (verdict still returned)", async () => {
    const body = okBatch(
      await reconcileBatch(
        {
          claims: [{ task: "t", claim: "c", authorized: { budgetUsd: 500, mayPurchase: true } }],
          evidence: { merchant: "U", amountUsd: 10 },
          judge: "local",
        },
        { allowJudge: false },
      ),
    );
    expect(body.judgeMode).toBe("unauthorized");
    expect(body.claims[0].judgeFindings).toEqual([]);
    expect(body.claims[0].status).toBe("supported");
  });
});
