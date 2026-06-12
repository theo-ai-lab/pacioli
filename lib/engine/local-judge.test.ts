import { describe, it, expect } from "vitest";
import { localJudge, localJudgeAvailable } from "./local-judge";
import type { DiffInput } from "./types";

const input: DiffInput = {
  claim: { agent: "a", task: "book the cheapest", text: "booked the cheapest option", authorized: { constraints: ["cheapest"] } },
  evidence: { source: "pasted", merchant: "Air", amountUsd: 278, date: null, items: [], recurring: false, excerpt: "a $199 option was available" },
};

// Live path runs only if an Ollama server is reachable; otherwise it skips (suite stays green).
const available = await localJudgeAvailable();

describe("local Ollama judge (optional, no API key)", () => {
  it.skipIf(!available)("returns badged CLAIM_MISMATCH findings or abstains when Ollama is running", async () => {
    const f = await localJudge(input);
    expect(Array.isArray(f)).toBe(true);
    for (const x of f) {
      expect(x.llmAssisted).toBe(true);
      expect(x.type).toBe("CLAIM_MISMATCH");
    }
  });

  it("degrades to [] (deterministic-only) when Ollama is absent — never throws", async () => {
    if (available) return;
    await expect(localJudge(input)).resolves.toEqual([]);
  });
});
