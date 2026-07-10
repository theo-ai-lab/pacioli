import { describe, it, expect } from "vitest";
import { audit, toCase, summarize } from "./audit";
import { toSarif } from "./sarif";
import { toJUnit } from "./junit";
import type { DiffInput } from "@pacioli-app/engine";

const overspend: DiffInput = {
  claim: { agent: "t", task: "book flight under $300", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "United", amountUsd: 378, date: null, items: [], recurring: false, excerpt: "$378" },
};
const clean: DiffInput = {
  claim: { agent: "t", task: "book", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "United", amountUsd: 278, date: null, items: [], recurring: false, excerpt: "$278" },
};

describe("audit reporters", () => {
  const results = audit([
    { id: "c1", input: overspend },
    { id: "c2", input: clean },
  ]);

  it("summarizes flagged vs clean cases", () => {
    expect(summarize(results)).toMatchObject({ cases: 2, flagged: 1 });
  });

  it("emits SARIF 2.1.0 with the four rules and a result per finding", () => {
    const sarif = toSarif(results);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("Pacioli");
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(4);
    expect(sarif.runs[0].results.map((r) => r.ruleId)).toContain("OVERSPEND");
    expect(sarif.runs[0].results[0].level).toBe("error"); // high severity → error
  });

  it("emits JUnit XML: a failure for the flagged case, a passing testcase for the clean one", () => {
    const xml = toJUnit(results);
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<failure type="OVERSPEND"');
    expect(xml).toContain('name="c2"');
  });

  it("normalizes loose row shapes via toCase", () => {
    expect(toCase({ id: "x", input: overspend }, 0)?.id).toBe("x");
    expect(toCase({ claim: overspend.claim, evidence: overspend.evidence }, 0)?.id).toBe("case-1");
    expect(toCase({ nope: 1 }, 0)).toBeNull();
  });
});
