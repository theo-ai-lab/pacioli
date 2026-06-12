import { describe, it, expect } from "vitest";
import { diff } from "./diff";
import { applyRules } from "./rules-dsl";
import { genInput, mulberry32 } from "./fuzz";
import { loadSeed, loadIncidents } from "./dataset";
import type { DiffInput, FindingType } from "./types";

// The DSL covers only the numeric/flag rules; compare those classes against the engine.
const NUMERIC: FindingType[] = ["OVERSPEND", "UNAUTH_RECURRENCE"];
const engineNumeric = (i: DiffInput): Set<FindingType> =>
  new Set(diff(i).findings.map((f) => f.type).filter((t) => NUMERIC.includes(t)));
const dslNumeric = (i: DiffInput): Set<FindingType> => new Set(applyRules(i).filter((t) => NUMERIC.includes(t)));
const eq = (a: Set<FindingType>, b: Set<FindingType>) => a.size === b.size && [...a].every((x) => b.has(x));

describe("declarative rule DSL", () => {
  it("agrees with the engine on OVERSPEND/UNAUTH across the labeled corpus", () => {
    for (const s of [...loadSeed(), ...loadIncidents()]) {
      expect(eq(dslNumeric(s.input), engineNumeric(s.input))).toBe(true);
    }
  });

  it("agrees with the engine across 5,000 fuzzed inputs (the data layer never drifts from code)", () => {
    const r = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const input = genInput(r);
      expect(eq(dslNumeric(input), engineNumeric(input))).toBe(true);
    }
  });

  it("rules are data — a new policy is an appended DeclRule, evaluated generically", () => {
    const fired = applyRules({
      claim: { agent: "a", task: "t", text: "x", authorized: { budgetUsd: 100, mayPurchase: true } },
      evidence: { source: "pasted", merchant: "m", amountUsd: 200, date: null, items: [], recurring: false, excerpt: "" },
    });
    expect(fired).toContain("OVERSPEND");
  });
});
