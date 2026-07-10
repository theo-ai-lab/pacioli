import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileEndpoint, type ReconcileSuccess } from "./reconcile-endpoint";
import { resolveJudge } from "../engine/judge-router";
import type { Finding } from "@pacioli-app/engine";

vi.mock("../engine/judge-router", () => ({ resolveJudge: vi.fn() }));
const mockResolve = vi.mocked(resolveJudge);

const body = (judge: string): unknown => ({
  task: "book",
  claim: "booked",
  authorized: { budgetUsd: 300, mayPurchase: true },
  evidence: { merchant: "U", amountUsd: 278 },
  judge,
});

function ok(r: Awaited<ReturnType<typeof reconcileEndpoint>>): ReconcileSuccess {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  return r.body;
}

const mismatch: Finding = {
  type: "CLAIM_MISMATCH",
  dimension: "item",
  severity: "medium",
  claimedRef: "c",
  actualRef: "a",
  llmAssisted: true,
  note: "n",
};

beforeEach(() => mockResolve.mockReset());

describe("endpoint judge contract (mocked router)", () => {
  it("UNAUTHORIZED: judge selection without allowJudge never reaches the router", async () => {
    const b = ok(await reconcileEndpoint(body("local")));
    expect(b.judgeMode).toBe("unauthorized");
    expect(b.judgeFindings).toEqual([]);
    expect(b.balanced).toBe(true); // deterministic verdict intact
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("UNAVAILABLE: an explicit backend that can't run is named, not silently empty", async () => {
    mockResolve.mockResolvedValue({ mode: "local", available: false, judge: async () => [] });
    const b = ok(await reconcileEndpoint(body("local"), { allowJudge: true }));
    expect(b.judgeMode).toBe("unavailable"); // NOT "local" + [] — that would read as "ran, found nothing"
    expect(b.judgeFindings).toEqual([]);
  });

  it("ERROR: a throwing judge degrades to the 200 deterministic verdict, never a 500", async () => {
    mockResolve.mockResolvedValue({
      mode: "anthropic",
      available: true,
      judge: async () => {
        throw new Error("API timeout");
      },
    });
    const b = ok(await reconcileEndpoint(body("anthropic"), { allowJudge: true }));
    expect(b.judgeMode).toBe("error");
    expect(b.judgeFindings).toEqual([]);
    expect(b.receiptId).toMatch(/^sha256:/);
  });

  it("RAN: an available judge's findings flow through, badged mode", async () => {
    mockResolve.mockResolvedValue({ mode: "local", available: true, judge: async () => [mismatch] });
    const b = ok(await reconcileEndpoint(body("local"), { allowJudge: true }));
    expect(b.judgeMode).toBe("local");
    expect(b.judgeFindings).toHaveLength(1);
    expect(b.judgeFindings[0].llmAssisted).toBe(true);
  });

  it("AUTO degrading to deterministic stays 'off' (the documented contract)", async () => {
    mockResolve.mockResolvedValue({ mode: "off", available: false, judge: async () => [] });
    const b = ok(await reconcileEndpoint(body("auto"), { allowJudge: true }));
    expect(b.judgeMode).toBe("off");
  });
});
