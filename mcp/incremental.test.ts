import { describe, it, expect } from "vitest";
import { reconcilePr, reconcileStreamTool } from "./incremental";

describe("MCP reconcile_pr tool logic", () => {
  it("flags an OVERSIZED PR as OVERSPEND and commits early, before CI, with a tamper-evident receipt", async () => {
    const r = await reconcilePr({
      number: 7,
      title: "small refactor",
      author: "claude-agent",
      maxChangedLines: 50,
      mayModifyCode: true,
      additions: 800,
      deletions: 100,
      touchedPaths: ["a.ts", "b.ts"],
      checksPassed: true,
      checksSummary: "12/12 green",
    });
    expect(r.committedClass).toBe("flagged");
    expect(r.commitAt).toBe(1); // step 0 = header, step 1 = diff size
    expect(r.committedEarly).toBe(true);
    expect(r.monotoneSafe).toBe(true);
    expect(r.finalClass).toBe("flagged");
    expect(r.finalVerdict.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(r.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(r.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags a REVIEW-ONLY PR that changed code as SCOPE_CREEP", async () => {
    const r = await reconcilePr({
      title: "review the PR",
      body: "LGTM, also pushed a fix",
      author: "claude-agent",
      mayModifyCode: false,
      scope: "review only — do not modify",
      additions: 40,
      deletions: 5,
      touchedPaths: ["x.ts"],
      checksPassed: true,
    });
    expect(r.committedClass).toBe("flagged");
    expect(r.finalVerdict.findings.map((f) => f.type)).toContain("SCOPE_CREEP");
  });

  it("clears an in-scope, within-budget PR (balanced) and never flips", async () => {
    const r = await reconcilePr({
      title: "fix typo",
      body: "one-liner",
      author: "claude-agent",
      maxChangedLines: 100,
      mayModifyCode: true,
      additions: 1,
      deletions: 1,
      touchedPaths: ["README.md"],
      checksPassed: true,
    });
    expect(r.committedClass).toBe("balanced");
    expect(r.finalClass).toBe("balanced");
    expect(r.monotoneSafe).toBe(true);
    expect(r.finalVerdict.findings).toEqual([]);
  });

  it("ABSTAINS on 'claims tests pass vs failing CI' (no CLAIM_MISMATCH) and flags it in the note", async () => {
    const r = await reconcilePr({
      title: "Add caching layer",
      body: "Adds an LRU cache. All tests pass.",
      author: "claude-agent",
      claimsTestsPass: true,
      maxChangedLines: 500,
      mayModifyCode: true,
      additions: 60,
      deletions: 5,
      touchedPaths: ["cache.ts"],
      checksPassed: false, // CI actually failed — the deterministic engine does NOT judge this
      checksSummary: "3 of 12 checks failed",
    });
    expect(r.finalVerdict.findings.some((f) => f.type === "CLAIM_MISMATCH")).toBe(false);
    expect(r.note).toMatch(/CLAIM_MISMATCH/);
    expect(r.note).toMatch(/LLM judge/i);
  });
});

describe("MCP reconcile_stream tool logic", () => {
  const overspend = {
    agent: "chatgpt-agent",
    task: "Book the cheapest nonstop under $300",
    claim: "Booked a nonstop for $278.",
    budgetUsd: 300,
    mayPurchase: true,
    merchant: "United Airlines",
    amountUsd: 378,
    excerpt: "Total $378.00 charged.",
  };

  it("reconciles a complete claim+evidence through an exploded stream and flags the overspend", async () => {
    const r = await reconcileStreamTool(overspend);
    expect(r.finalClass).toBe("flagged");
    expect(r.finalVerdict.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(r.committedClass).toBe("flagged");
    expect(r.monotoneSafe).toBe(true);
    expect(r.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("commits EARLIER when the deciding evidence (amount) arrives first", async () => {
    const amountFirst = await reconcileStreamTool({ ...overspend, revealOrder: ["amount"] });
    const recurringFirst = await reconcileStreamTool({ ...overspend, revealOrder: ["recurring"] });
    expect(amountFirst.commitAt).not.toBeNull();
    expect(recurringFirst.commitAt).not.toBeNull();
    // amount is the deciding class for an overspend — revealing it first commits one prefix sooner
    expect(amountFirst.commitAt!).toBeLessThan(recurringFirst.commitAt!);
    // ...but the FINAL verdict is identical regardless of arrival order (engine consistency)
    expect(amountFirst.finalClass).toBe(recurringFirst.finalClass);
  });

  it("balances a clean research-only run (no purchase authorized, $0 charged)", async () => {
    const r = await reconcileStreamTool({
      agent: "claude-agent",
      task: "Compare three desks, don't buy anything",
      claim: "Compared three desks, no purchase.",
      mayPurchase: false,
      merchant: "—",
      amountUsd: 0,
      excerpt: "No order placed.",
    });
    expect(r.finalClass).toBe("balanced");
    expect(r.finalVerdict.findings).toEqual([]);
  });
});
