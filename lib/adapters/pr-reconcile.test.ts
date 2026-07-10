import { describe, it, expect } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { prToDiffInput, prToIncrements, reconcilePullRequest, type PullRequestClaim } from "./pr-reconcile";
import { diff } from "@pacioli-app/engine";
import { streamJudge } from "../engine/streaming-judge";

describe("pr-reconcile — claim mapping", () => {
  it("maps the change budget, lines changed, review mandate, and PR fields faithfully", () => {
    const claim: PullRequestClaim = {
      number: 42,
      title: "Add rate limiter",
      body: "Implements a token-bucket limiter.",
      author: "claude-agent",
      task: "add a rate limiter",
      scope: "implement the limiter",
      maxChangedLines: 200,
      mayModifyCode: true,
    };
    const input = prToDiffInput(claim, { additions: 120, deletions: 30, touchedPaths: ["limiter.ts"] });
    expect(input.claim.agent).toBe("claude-agent");
    expect(input.claim.authorized.budgetUsd).toBe(200); // change budget = authorized lines
    expect(input.evidence.amountUsd).toBe(150); // 120 + 30 lines changed
    expect(input.claim.authorized.mayPurchase).toBe(true);
    expect(input.claim.authorized.mayRecur).toBe(true); // recurrence is N/A for a PR
    expect(input.evidence.recurring).toBe(false);
    expect(input.evidence.items).toEqual(["limiter.ts"]);
  });

  it("leaves amount UNSEEN (null) until a diff stat arrives", () => {
    const input = prToDiffInput({ title: "t", body: "b", author: "a" }, {});
    expect(input.evidence.amountUsd).toBeNull();
  });

  it("emits a 4-step arrival stream: contract → diff size → files → CI", () => {
    const incs = prToIncrements({ title: "t", body: "b", author: "a", maxChangedLines: 10 }, { additions: 5, deletions: 1 });
    expect(incs).toHaveLength(4);
    expect(incs[0].authFinal).toBe(true);
    expect(incs[1].evidence?.amountUsd).toBe(6);
    expect(incs[2].closes).toEqual(["addon", "sent"]);
    expect(incs[3].final).toBe(true);
  });
});

describe("pr-reconcile — incremental early commit (deterministic rules)", () => {
  it("flags an OVERSIZED PR as OVERSPEND at the diff-size step, before CI finishes", () => {
    const run = reconcilePullRequest(
      { title: "small refactor", body: "tiny cleanup", author: "claude-agent", maxChangedLines: 50, mayModifyCode: true },
      { additions: 800, deletions: 100, touchedPaths: ["a.ts", "b.ts"], checksPassed: true, checksSummary: "12/12 green" },
    );
    expect(run.commitAt).toBe(1); // step 0 = header, step 1 = diff size
    expect(run.committedClass).toBe("flagged");
    expect(run.committedEarly).toBe(true);
    expect(run.heldToEnd).toBe(true);
    expect(run.finalVerdict.findings.map((f) => f.type)).toContain("OVERSPEND");
  });

  it("flags a REVIEW-ONLY PR that changed code as SCOPE_CREEP", () => {
    const run = reconcilePullRequest(
      { title: "review the PR", body: "LGTM, also pushed a fix", author: "claude-agent", mayModifyCode: false, scope: "review only — do not modify" },
      { additions: 40, deletions: 5, touchedPaths: ["x.ts"], checksPassed: true },
    );
    expect(run.committedClass).toBe("flagged");
    expect(run.heldToEnd).toBe(true);
    expect(run.finalVerdict.findings.map((f) => f.type)).toContain("SCOPE_CREEP");
  });

  it("clears an in-scope, within-budget PR (balanced) and never flips", () => {
    const run = reconcilePullRequest(
      { title: "fix typo", body: "one-liner", author: "claude-agent", maxChangedLines: 100, mayModifyCode: true },
      { additions: 1, deletions: 1, touchedPaths: ["README.md"], checksPassed: true },
    );
    expect(run.committedClass).toBe("balanced");
    expect(run.heldToEnd).toBe(true);
    expect(run.finalVerdict.findings).toEqual([]);
  });
});

// ── the CLAIM_MISMATCH residual: "claims all tests pass" vs CI — routed to the streamed LLM judge.
//    Proven here with an INJECTED mock model (no API key); this is where the hosted model plugs in.

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

function streamParts(json: string, n = 6): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
  ];
  const size = Math.max(1, Math.ceil(json.length / n));
  for (let i = 0; i < json.length; i += size) parts.push({ type: "text-delta", id: "0", delta: json.slice(i, i + size) });
  parts.push({ type: "text-end", id: "0" });
  parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
  return parts;
}

function mockModel(raw: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: streamParts(raw), initialDelayInMs: 0, chunkDelayInMs: 0 }),
    }),
  });
}

describe("pr-reconcile — CLAIM_MISMATCH residual via the injected (mock) judge, no API key", () => {
  const claim: PullRequestClaim = {
    title: "Add caching layer",
    body: "Adds an LRU cache.",
    author: "claude-agent",
    claimsTestsPass: true, // the agent asserted green CI...
    maxChangedLines: 500,
    mayModifyCode: true,
  };
  // ...but CI actually failed. The deterministic engine ABSTAINS on this (it is the fuzzy residual).
  const evidence = { additions: 60, deletions: 5, touchedPaths: ["cache.ts"], checksPassed: false, checksSummary: "3 of 12 checks failed" };

  it("the deterministic engine produces NO CLAIM_MISMATCH (it abstains and defers to the judge)", () => {
    const v = diff(prToDiffInput(claim, evidence));
    expect(v.findings.some((f) => f.type === "CLAIM_MISMATCH")).toBe(false);
  });

  it("the injected judge mints a badged CLAIM_MISMATCH when it confidently contradicts 'tests pass'", async () => {
    const input = prToDiffInput(claim, evidence);
    const model = mockModel(
      JSON.stringify({
        mismatch: true,
        confidence: 0.93,
        dimension: "item",
        severity: "high",
        claimedRef: "all tests pass",
        actualRef: "3 of 12 checks failed",
        rationale: "The PR claims passing tests but CI reports 3 failed checks.",
      }),
    );
    const handle = streamJudge(input, { model });
    for await (const _ of handle.textStream) void _; // drain the pull-based mock stream
    const res = await handle.final();
    expect(res.state).toBe("match");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ type: "CLAIM_MISMATCH", llmAssisted: true, actualRef: "3 of 12 checks failed" });
  });
});
