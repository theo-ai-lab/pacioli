import { describe, it, expect, afterEach } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import {
  streamJudge,
  resolveStreamingModel,
  resolveStreamState,
  findingsFromVerdict,
  streamingJudgeEnabled,
  StreamJudgeSchema,
  type StreamJudgeVerdict,
} from "./streaming-judge";
import type { DiffInput } from "@pacioli-app/engine";

// ── a mock model that streams a JSON object out as token-ish text deltas (NO API key) ──────────
const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

/** Slice a JSON payload into N text-delta parts so the test exercises real token-by-token streaming. */
function streamParts(json: string, n = 8): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
  ];
  const size = Math.max(1, Math.ceil(json.length / n));
  for (let i = 0; i < json.length; i += size) {
    parts.push({ type: "text-delta", id: "0", delta: json.slice(i, i + size) });
  }
  parts.push({ type: "text-end", id: "0" });
  parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
  return parts;
}

/** Build an injectable mock model that emits `raw` (a JSON string) as the streamed object. */
function mockModel(raw: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: streamParts(raw), initialDelayInMs: 0, chunkDelayInMs: 0 }),
    }),
  });
}

const verdictJson = (v: Partial<StreamJudgeVerdict>): string =>
  JSON.stringify({
    mismatch: false,
    confidence: 0.9,
    dimension: "item",
    severity: "medium",
    claimedRef: "",
    actualRef: "",
    rationale: "",
    ...v,
  });

const input: DiffInput = {
  claim: { agent: "comet", task: "book the cheapest nonstop", text: "booked the cheapest nonstop", authorized: {} },
  evidence: {
    source: "email",
    merchant: "United",
    amountUsd: 412,
    date: "2026-06-01",
    items: ["UA 88 — 1 stop via DEN"],
    recurring: false,
    excerpt: "Itinerary: UA 88, 1 stop via Denver",
  },
};

describe("streamJudge — injectable model, streamed token-by-token (no API key)", () => {
  it("streams the verdict as multiple text chunks and resolves a confident MATCH to a badged finding", async () => {
    const model = mockModel(
      verdictJson({
        mismatch: true,
        confidence: 0.92,
        dimension: "item",
        severity: "high",
        claimedRef: "the cheapest nonstop",
        actualRef: "UA 88, 1 stop via Denver",
        rationale: "Claim says nonstop; itinerary shows a stop in Denver.",
      }),
    );

    const handle = streamJudge(input, { model });

    // token-by-token: the raw text arrives in more than one chunk and reassembles to valid JSON
    let chunks = 0;
    let text = "";
    for await (const delta of handle.textStream) {
      chunks++;
      text += delta;
    }
    expect(chunks).toBeGreaterThan(1);
    expect(() => StreamJudgeSchema.parse(JSON.parse(text))).not.toThrow();

    const res = await handle.final();
    expect(res.state).toBe("match");
    expect(res.confidence).toBeCloseTo(0.92);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({
      type: "CLAIM_MISMATCH",
      llmAssisted: true,
      claimedRef: "the cheapest nonstop",
      actualRef: "UA 88, 1 stop via Denver",
    });
  });

  it("exposes progressive structured partials with a growing rationale", async () => {
    const model = mockModel(
      verdictJson({ mismatch: true, confidence: 0.9, rationale: "Nonstop claim contradicted by a 1-stop itinerary." }),
    );
    const handle = streamJudge(input, { model });

    const rationales: string[] = [];
    for await (const partial of handle.partialStream) {
      if (typeof partial.rationale === "string") rationales.push(partial.rationale);
    }
    // last partial holds the full rationale; lengths are monotonically non-decreasing
    expect(rationales.at(-1)).toContain("1-stop itinerary");
    for (let i = 1; i < rationales.length; i++) {
      expect(rationales[i].length).toBeGreaterThanOrEqual(rationales[i - 1].length);
    }
  });

  it("returns CLEAN (no finding) for a confident non-mismatch", async () => {
    const handle = streamJudge(input, { model: mockModel(verdictJson({ mismatch: false, confidence: 0.95 })) });
    for await (const _ of handle.textStream) void _;
    const res = await handle.final();
    expect(res.state).toBe("clean");
    expect(res.findings).toEqual([]);
  });

  it("ABSTAINS on low confidence — a hedged mismatch never becomes a finding (graceful-hallucination guard)", async () => {
    const handle = streamJudge(input, {
      model: mockModel(verdictJson({ mismatch: true, confidence: 0.31, rationale: "Might be a stop, hard to tell." })),
      floor: 0.6,
    });
    for await (const _ of handle.textStream) void _;
    const res = await handle.final();
    expect(res.state).toBe("low-confidence");
    expect(res.findings).toEqual([]); // the key safety property: no fabricated accusation
    expect(res.verdict?.mismatch).toBe(true); // the model DID say mismatch — we deliberately abstained
  });

  it("resolves to ERROR (never throws, never fabricates) when the stream is not valid JSON", async () => {
    const handle = streamJudge(input, { model: mockModel("{ this is not json") });
    // draining the raw token stream is fine; only structured parsing fails
    for await (const _ of handle.textStream) void _;
    const res = await handle.final();
    expect(res.state).toBe("error");
    expect(res.findings).toEqual([]);
    expect(res.verdict).toBeNull();
    expect(res.error).toBeTruthy();
  });
});

describe("streamJudge — pure verdict→state mapping (the low-confidence boundary)", () => {
  const base: StreamJudgeVerdict = {
    mismatch: true,
    confidence: 0.6,
    dimension: "item",
    severity: "high",
    claimedRef: "a",
    actualRef: "b",
    rationale: "x",
  };

  it("confidence at the floor counts as confident; just below abstains", () => {
    expect(resolveStreamState({ ...base, confidence: 0.6 }, 0.6)).toBe("match");
    expect(resolveStreamState({ ...base, confidence: 0.59 }, 0.6)).toBe("low-confidence");
    expect(findingsFromVerdict({ ...base, confidence: 0.6 }, 0.6)).toHaveLength(1);
    expect(findingsFromVerdict({ ...base, confidence: 0.59 }, 0.6)).toEqual([]);
  });

  it("a confident non-mismatch is clean, not a finding", () => {
    expect(resolveStreamState({ ...base, mismatch: false, confidence: 0.99 }, 0.6)).toBe("clean");
    expect(findingsFromVerdict({ ...base, mismatch: false, confidence: 0.99 }, 0.6)).toEqual([]);
  });
});

describe("streamingJudge gating (no live API call)", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = orig;
  });

  it("is disabled when no key is set, and resolveStreamingModel throws without a model or key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(streamingJudgeEnabled()).toBe(false);
    expect(() => resolveStreamingModel()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("uses an injected model verbatim even with no key (the test/alternate-provider seam)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const m = mockModel(verdictJson({}));
    expect(resolveStreamingModel(m)).toBe(m);
  });

  it("reports enabled when a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    expect(streamingJudgeEnabled()).toBe(true);
  });
});
