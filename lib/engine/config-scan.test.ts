import { describe, it, expect } from "vitest";
import { scanConfig, configSafe } from "./config-scan";

describe("agent-config security scanner", () => {
  it("passes a well-formed config (budget cap, narrow allowlist, approval-gated dangerous tool)", () => {
    const cfg = {
      authorized: { budgetUsd: 200, mayPurchase: true, mayRecur: false },
      tools: { allowed: ["search", "read_file", "send_email"], requireApproval: ["send_email"] },
    };
    expect(configSafe(cfg)).toBe(true);
    expect(scanConfig(cfg).some((f) => f.severity === "critical")).toBe(false);
  });

  it("flags purchase permission with no budget cap (high)", () => {
    const f = scanConfig({ authorized: { mayPurchase: true }, tools: { allowed: ["search"] } });
    expect(f.map((x) => x.code)).toContain("NO_BUDGET_CAP");
  });

  it("flags a wildcard tool allowlist (critical)", () => {
    const f = scanConfig({ tools: { allowed: ["*"] } });
    expect(f.find((x) => x.code === "UNRESTRICTED_TOOLS")?.severity).toBe("critical");
    expect(configSafe({ tools: { allowed: ["*"] } })).toBe(false);
  });

  it("flags a dangerous tool with no approval gate (critical), but only medium when gated", () => {
    expect(scanConfig({ tools: { allowed: ["wire_money"] } }).find((x) => x.code === "DANGEROUS_TOOL_NO_APPROVAL")?.severity).toBe("critical");
    expect(scanConfig({ tools: { allowed: ["wire_money"], requireApproval: ["wire_money"] } }).find((x) => x.code === "DANGEROUS_TOOL")?.severity).toBe("medium");
    // approval-gated dangerous tool is informational, so the config still passes the CI gate
    expect(configSafe({ tools: { allowed: ["wire_money"], requireApproval: ["wire_money"] } })).toBe(true);
  });

  it("flags a missing tool policy as ungoverned (medium)", () => {
    expect(scanConfig({ authorized: { budgetUsd: 50, mayPurchase: true } }).map((x) => x.code)).toContain("NO_TOOL_POLICY");
  });
});
