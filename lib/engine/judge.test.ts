import { describe, it, expect, afterEach } from "vitest";
import { judge, judgeEnabled } from "./judge";
import type { DiffInput } from "@pacioli-app/engine";

const sample: DiffInput = {
  claim: { agent: "a", task: "t", text: "t", authorized: {} },
  evidence: { source: "pasted", merchant: "m", amountUsd: null, date: null, items: [], recurring: false, excerpt: "" },
};

describe("judge gating (no live API call)", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = orig;
  });

  it("is disabled when no key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(judgeEnabled()).toBe(false);
  });

  it("throws instead of calling the model when disabled", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(judge(sample)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("reports enabled when a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    expect(judgeEnabled()).toBe(true);
  });
});
