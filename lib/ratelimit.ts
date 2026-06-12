/**
 * Pacioli — rate limit + daily cost ceiling for the gated LLM judge.
 *
 * The deterministic engine is free and runs client-side (unlimited). Only the PAID judge needs a guard so a
 * public deployment can't be abused into a large API bill. This is per-serverless-instance memory (resets on
 * cold start) — adequate for a low-traffic demo; for higher traffic, back it with Vercel KV / Upstash Redis
 * (swap the two maps for a KV store; the interface stays the same).
 */

const WINDOW_MS = 60_000; // sliding window
const MAX_PER_WINDOW = 5; // per key (≈ per IP) per minute
const DAILY_CEILING = 300; // hard cap per instance per day — a cost circuit-breaker

const buckets = new Map<string, number[]>();
let dayStamp = "";
let dayCount = 0;

const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

export interface RateDecision {
  ok: boolean;
  reason?: "rate" | "daily";
  retryAfterMs?: number;
}

/** Allow at most MAX_PER_WINDOW judge calls per key per window, and DAILY_CEILING total per day. */
export function checkJudgeRate(key = "global", now = Date.now()): RateDecision {
  // daily cost ceiling (resets each calendar day)
  const d = dayKey(now);
  if (d !== dayStamp) {
    dayStamp = d;
    dayCount = 0;
  }
  if (dayCount >= DAILY_CEILING) return { ok: false, reason: "daily" };

  // sliding window per key
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    buckets.set(key, hits);
    return { ok: false, reason: "rate", retryAfterMs: WINDOW_MS - (now - hits[0]) };
  }
  hits.push(now);
  buckets.set(key, hits);
  dayCount++;
  return { ok: true };
}

export const RATE_LIMITS = { windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW, dailyCeiling: DAILY_CEILING } as const;

/** Test-only: clear all counters. */
export function __resetRateLimit(): void {
  buckets.clear();
  dayStamp = "";
  dayCount = 0;
}
