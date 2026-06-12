import { describe, it, expect } from "vitest";
import { toCase, type AuditResult } from "./audit";
import { toJUnit } from "./junit";
import { toSarif } from "./sarif";
import type { DiffInput } from "../engine/types";

const goodInput: DiffInput = {
  claim: { agent: "a", task: "book", text: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "pasted", merchant: "U", amountUsd: 278, date: null, items: [], recurring: false, excerpt: "ok" },
};

describe("toCase — per-field rejection of malformed corpus rows", () => {
  it("rejects a STRING amountUsd (the documented silent-false-negative shape)", () => {
    const row = { id: "bad", claim: goodInput.claim, evidence: { ...goodInput.evidence, amountUsd: "9999" } };
    expect(toCase(row, 0)).toBeNull();
  });

  it("rejects null authorized, non-string items, and boolean-typed fields gone wrong", () => {
    expect(toCase({ claim: { ...goodInput.claim, authorized: null }, evidence: goodInput.evidence }, 0)).toBeNull();
    expect(toCase({ claim: goodInput.claim, evidence: { ...goodInput.evidence, items: [123] } }, 0)).toBeNull();
    expect(toCase({ claim: goodInput.claim, evidence: { ...goodInput.evidence, recurring: "yes" } }, 0)).toBeNull();
  });

  it("accepts a well-formed row", () => {
    expect(toCase({ id: "ok", claim: goodInput.claim, evidence: goodInput.evidence }, 0)?.id).toBe("ok");
  });
});

const hostile: AuditResult = {
  id: 'a"><x>&',
  input: goodInput,
  verdict: {
    balanced: false,
    findings: [
      {
        type: "OVERSPEND",
        dimension: "money",
        severity: "high",
        claimedRef: "<script>alert(1)</script>\u0007ref",
        actualRef: "x & 'y'",
        llmAssisted: false,
        note: 'note "quoted" <tag>',
      },
    ],
  },
};

describe("report emitters — hostile input stays contained", () => {
  it("JUnit escapes hostile ids/refs and strips illegal control chars", () => {
    const xml = toJUnit([hostile]);
    expect(xml).toContain('name="a&quot;&gt;&lt;x&gt;&amp;"');
    expect(xml).not.toContain("<script>");
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it("JUnit renders unscorable as <skipped> and never counts it as a failure", () => {
    const unscorable: AuditResult = { id: "u1", input: goodInput, verdict: { balanced: true, findings: [], unscorable: true } };
    const xml = toJUnit([unscorable]);
    expect(xml).toContain("<skipped");
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('skipped="1"');
  });

  it("SARIF percent-encodes untrusted ids in the artifact URI", () => {
    const traversal: AuditResult = { ...hostile, id: "../../../etc/passwd" };
    const sarif = toSarif([traversal]);
    const loc = sarif.runs[0].results[0].locations[0] as { physicalLocation: { artifactLocation: { uri: string } } };
    expect(loc.physicalLocation.artifactLocation.uri).toBe("claim/..%2F..%2F..%2Fetc%2Fpasswd");
  });
});
