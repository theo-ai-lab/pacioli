import { describe, it, expect } from "vitest";
import { auditTools } from "./tooluse";

describe("tool-use auditor — unknown approval state fails CLOSED", () => {
  it("a call with approval UNKNOWN (undefined) to an approval-required tool is an APPROVAL_BYPASS", () => {
    const findings = auditTools([{ name: "send_email" }], { allowed: ["send_email"], requireApproval: ["send_email"] });
    expect(findings.map((f) => f.type)).toEqual(["APPROVAL_BYPASS"]);
  });

  it("only an explicit approved:true clears the gate", () => {
    const policy = { allowed: ["send_email"], requireApproval: ["send_email"] };
    expect(auditTools([{ name: "send_email", approved: true }], policy)).toEqual([]);
    expect(auditTools([{ name: "send_email", approved: false }], policy).map((f) => f.type)).toEqual(["APPROVAL_BYPASS"]);
  });
});
