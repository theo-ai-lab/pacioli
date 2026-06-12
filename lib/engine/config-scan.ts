/**
 * Pacioli — agent-config security scanner (pre-deployment hygiene; the "prevent" role).
 *
 * A deterministic linter over an agent's authorization + tool policy: it flags risky settings BEFORE
 * the agent runs — a purchase permission with no budget cap, ungoverned or wildcard tool access, or a
 * dangerous tool with no human-approval gate. Pure, zero-dep; drop into CI and fail the build on any
 * high/critical finding.
 */
import type { Authorization } from "./types";
import type { ToolPolicy } from "./tooluse";

export interface AgentConfig {
  authorized?: Authorization;
  tools?: ToolPolicy;
}

export type ConfigSeverity = "medium" | "high" | "critical";

export interface ConfigFinding {
  code: string;
  severity: ConfigSeverity;
  message: string;
}

// Tool names that imply irreversible / high-impact actions.
const DANGEROUS = /(delete|drop|destroy|wipe|wire|transfer|payout|refund|exec|shell|sudo|deploy|send_email)/i;

export function scanConfig(cfg: AgentConfig): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const a = cfg.authorized ?? {};
  const t = cfg.tools;

  if (a.mayPurchase === true && (a.budgetUsd === undefined || a.budgetUsd === null || a.budgetUsd <= 0)) {
    out.push({ code: "NO_BUDGET_CAP", severity: "high", message: "purchases are authorized but no positive budget cap is set" });
  }
  if (a.mayRecur === true) {
    out.push({ code: "RECURRENCE_ALLOWED", severity: "medium", message: "recurring charges are authorized — confirm this is intended" });
  }

  if (!t) {
    out.push({ code: "NO_TOOL_POLICY", severity: "medium", message: "no tool allowlist is defined — tool calls are ungoverned" });
  } else {
    const allowed = t.allowed ?? [];
    const mustApprove = new Set((t.requireApproval ?? []).map((x) => x.toLowerCase()));
    if (allowed.some((x) => x.trim() === "*")) {
      out.push({ code: "UNRESTRICTED_TOOLS", severity: "critical", message: "tool allowlist contains a wildcard '*' — the agent can call anything" });
    }
    for (const tool of allowed) {
      if (!DANGEROUS.test(tool)) continue;
      if (mustApprove.has(tool.toLowerCase())) {
        // approval-gating mitigates it → informational, not a blocking finding
        out.push({ code: "DANGEROUS_TOOL", severity: "medium", message: `high-impact tool "${tool}" is allowed (approval-gated — confirm intended)` });
      } else {
        out.push({ code: "DANGEROUS_TOOL_NO_APPROVAL", severity: "critical", message: `high-impact tool "${tool}" is allowed with NO human-approval gate` });
      }
    }
  }
  return out;
}

/** True iff the config has no high/critical findings (use as a CI gate). */
export function configSafe(cfg: AgentConfig): boolean {
  return !scanConfig(cfg).some((f) => f.severity === "high" || f.severity === "critical");
}
