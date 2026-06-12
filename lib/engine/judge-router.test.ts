import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveJudge } from "./judge-router";

// HERMETIC: the router probes real ambient state (an Ollama server on localhost, ANTHROPIC_API_KEY)
// — on a dev machine that actually runs Ollama (the documented local-judge setup) unmocked tests
// would flip. Mock the probe and pin the env so these assertions hold everywhere.
const ambient = vi.hoisted(() => ({ localAvailable: false }));
vi.mock("./local-judge", () => ({
  localJudgeAvailable: async () => ambient.localAvailable,
  localJudge: async () => [],
  fence: (s: string, max = 600) => s.replace(/[<>]/g, " ").slice(0, max), // judge.ts imports this
}));

const originalKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  ambient.localAvailable = false;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  else delete process.env.ANTHROPIC_API_KEY;
});

describe("judge router", () => {
  it("'off' is always deterministic-only", async () => {
    const r = await resolveJudge("off");
    expect(r.mode).toBe("off");
    expect(r.available).toBe(false);
    expect(await r.judge({} as never)).toEqual([]);
  });

  it("'auto' degrades to off when neither a local model nor a key is present", async () => {
    const r = await resolveJudge("auto");
    expect(r.mode).toBe("off");
    expect(await r.judge({} as never)).toEqual([]);
  });

  it("explicit modes report unavailability without throwing", async () => {
    expect((await resolveJudge("local")).available).toBe(false);
    expect((await resolveJudge("anthropic")).available).toBe(false);
  });

  it("'auto' prefers the on-device judge when it is reachable", async () => {
    ambient.localAvailable = true;
    const r = await resolveJudge("auto");
    expect(r.mode).toBe("local");
    expect(r.available).toBe(true);
    expect(await r.judge({} as never)).toEqual([]); // routed to the (mocked) local judge
  });

  it("'anthropic' becomes available when a key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const r = await resolveJudge("anthropic");
    expect(r.mode).toBe("anthropic");
    expect(r.available).toBe(true); // judge() itself is NOT called here — no network
  });
});
