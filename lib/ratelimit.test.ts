import { describe, it, expect, beforeEach } from "vitest";
import { checkJudgeRate, RATE_LIMITS, __resetRateLimit } from "./ratelimit";

beforeEach(() => __resetRateLimit());

describe("judge rate limit (deploy-safe)", () => {
  it("allows up to maxPerWindow then blocks within the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMITS.maxPerWindow; i++) {
      expect(checkJudgeRate("ip-a", t0 + i).ok).toBe(true);
    }
    const blocked = checkJudgeRate("ip-a", t0 + RATE_LIMITS.maxPerWindow);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("rate");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("recovers after the window slides", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < RATE_LIMITS.maxPerWindow; i++) checkJudgeRate("ip-b", t0 + i);
    expect(checkJudgeRate("ip-b", t0).ok).toBe(false);
    expect(checkJudgeRate("ip-b", t0 + RATE_LIMITS.windowMs + 1).ok).toBe(true);
  });

  it("keeps separate keys independent", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < RATE_LIMITS.maxPerWindow; i++) checkJudgeRate("ip-c", t0 + i);
    expect(checkJudgeRate("ip-c", t0).ok).toBe(false);
    expect(checkJudgeRate("ip-d", t0).ok).toBe(true); // different key, fresh budget
  });

  it("enforces the daily ceiling as a cost circuit-breaker", () => {
    const day = Date.parse("2026-06-06T00:00:00Z");
    // spread across keys + time so the per-minute window never blocks first
    for (let i = 0; i < RATE_LIMITS.dailyCeiling; i++) {
      expect(checkJudgeRate(`k${i}`, day + i * 1000).ok).toBe(true);
    }
    expect(checkJudgeRate("k-final", day + RATE_LIMITS.dailyCeiling * 1000).reason).toBe("daily");
  });
});
