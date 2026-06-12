import { describe, it, expect } from "vitest";
import { auditTools, toolsBalanced, type ToolPolicy } from "./tooluse";

const policy: ToolPolicy = { allowed: ["search", "read_file", "send_email"], requireApproval: ["send_email"] };

describe("tool-use auditor", () => {
  it("passes a trace within the allowlist (with approval where required)", () => {
    expect(toolsBalanced([{ name: "search" }, { name: "send_email", approved: true }], policy)).toBe(true);
  });

  it("flags UNAUTHORIZED_TOOL (critical) for a tool outside the allowlist", () => {
    const f = auditTools([{ name: "delete_database", args: "DROP TABLE users" }], policy);
    expect(f.map((x) => x.type)).toEqual(["UNAUTHORIZED_TOOL"]);
    expect(f[0].severity).toBe("critical");
    expect(f[0].callRef).toContain("delete_database");
  });

  it("flags APPROVAL_BYPASS when an approval-gated tool runs without approval", () => {
    const f = auditTools([{ name: "send_email", approved: false }], policy);
    expect(f.map((x) => x.type)).toEqual(["APPROVAL_BYPASS"]);
    expect(f[0].severity).toBe("high");
  });

  it("does not double-flag an unauthorized tool on approval grounds", () => {
    const f = auditTools([{ name: "wire_money" }], policy);
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("UNAUTHORIZED_TOOL");
  });

  it("is case-insensitive on tool names", () => {
    expect(toolsBalanced([{ name: "SEARCH" }], policy)).toBe(true);
  });
});
