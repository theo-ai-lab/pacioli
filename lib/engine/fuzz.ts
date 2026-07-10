/**
 * Pacioli — property-based invariant fuzzer.
 *
 * Generates seeded, mutated (claim, evidence) pairs — biased toward the rule boundaries —
 * runs the engine, and asserts every contract in SPEC.md / packages/engine/src/spec.ts holds, plus
 * determinism. Reproducible: same (cases, seed) ⇒ same run. Run: `npm run fuzz`.
 */

import { diff } from "@pacioli-app/engine";
import { checkInvariants, type Violation } from "@pacioli-app/engine";
import type { DiffInput, EvidenceSource } from "@pacioli-app/engine";

// deterministic PRNG (mulberry32) — reproducible fuzzing, no Math.random
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTS = ["chatgpt-agent", "claude-agent", "comet", "gemini-agent"];
const SOURCES: EvidenceSource[] = ["email", "merchant", "pasted", "web"];
const MERCHANTS = ["United", "Stackly", "Uplift", "—"];
const ADDONS = ["seat", "insurance", "item", "add-on", "bag"];
const PERIODS = ["weekly", "monthly", "annual"] as const;

export function genInput(r: () => number): DiffInput {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const maybe = <T>(v: T): T | undefined => (r() < 0.5 ? v : undefined);
  const money = (max: number) => Math.round(r() * max * 100) / 100;

  // budget: include null / 0 / negative / normal to exercise every branch
  const budget = pick<number | null>([null, 0, money(2000), -money(50)]);

  // amount: include null / 0 / large / a value engineered to sit right on the OVERSPEND boundary
  const boundary =
    typeof budget === "number" && budget > 0
      ? Number((budget * 1.02 + (r() < 0.5 ? r() * 2 : -(r() * 2))).toFixed(2)) // straddle ceiling + floor
      : money(50);
  const amount = pick<number | null>([null, 0, money(5000), boundary, boundary]);

  const recurring = r() < 0.4;

  return {
    claim: {
      agent: pick(AGENTS),
      task: "fuzz task",
      text: "fuzz claim",
      authorized: {
        budgetUsd: budget,
        scope: maybe("research only"),
        constraints: r() < 0.5 ? ["nonstop", "cheapest", "on time"].slice(0, Math.floor(r() * 4)) : undefined,
        mayPurchase: pick([true, false, undefined]),
        mayRecur: pick([true, false, undefined]),
      },
    },
    evidence: {
      source: pick(SOURCES),
      merchant: pick(MERCHANTS),
      amountUsd: amount,
      date: r() < 0.7 ? "2026-06-14" : null,
      items: Array.from({ length: Math.floor(r() * 4) }, () => pick(ADDONS)),
      recurring,
      recurringPeriod: recurring ? pick(PERIODS) : undefined,
      excerpt: "[SYNTHETIC] fuzz",
    },
  };
}

export interface FuzzFailure {
  seed: number;
  index: number;
  input: DiffInput;
  violations: Violation[];
}

export interface FuzzResult {
  cases: number;
  seed: number;
  failures: FuzzFailure[];
  determinismFailures: number;
}

export function fuzz(cases = 10_000, seed = 1234): FuzzResult {
  const r = mulberry32(seed);
  const failures: FuzzFailure[] = [];
  let determinismFailures = 0;

  for (let index = 0; index < cases; index++) {
    const input = genInput(r);
    const v1 = diff(input);
    const v2 = diff(input);
    if (JSON.stringify(v1) !== JSON.stringify(v2)) determinismFailures++;
    const violations = checkInvariants(input, v1);
    if (violations.length) failures.push({ seed, index, input, violations });
  }

  return { cases, seed, failures, determinismFailures };
}
