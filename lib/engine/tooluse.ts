/**
 * Pacioli — tool-use / tool-misuse auditor (a parallel surface to the money/scope engine).
 *
 * The core engine (diff.ts) reconciles money & scope CLAIMS. This module audits an agent's TOOL-CALL
 * trace against a tool policy — the OWASP-Agentic "Tool Misuse" (ASI02) / "Identity & Privilege Abuse"
 * (ASI03) surface. Kept SEPARATE from the 4-class engine on purpose: a tool trace is a different input
 * shape, so it gets its own deterministic detector rather than destabilizing the verified core. Pure,
 * no model, no network.
 */

export interface ToolCall {
  name: string;
  /** Whether a required human approval was obtained before this call (if known). */
  approved?: boolean;
  /** Optional short, redacted argument summary for the citation line. */
  args?: string;
}

export interface ToolPolicy {
  /** The only tools the agent was authorized to call. A call to anything else is unauthorized. */
  allowed: string[];
  /** Tools that require explicit human approval before each use. */
  requireApproval?: string[];
}

export type ToolFindingType = "UNAUTHORIZED_TOOL" | "APPROVAL_BYPASS";

export interface ToolFinding {
  type: ToolFindingType;
  tool: string;
  severity: "high" | "critical";
  /** The exact tool call this finding cites. */
  callRef: string;
  note: string;
}

const ref = (c: ToolCall): string => (c.args ? `${c.name}(${c.args})` : c.name);

/** Audit a tool-call trace against a policy. Empty result = every call respected the policy. */
export function auditTools(calls: ToolCall[], policy: ToolPolicy): ToolFinding[] {
  const allowed = new Set(policy.allowed.map((t) => t.toLowerCase()));
  const mustApprove = new Set((policy.requireApproval ?? []).map((t) => t.toLowerCase()));
  const findings: ToolFinding[] = [];

  for (const call of calls) {
    const name = call.name.toLowerCase();
    if (!allowed.has(name)) {
      findings.push({
        type: "UNAUTHORIZED_TOOL",
        tool: call.name,
        severity: "critical",
        callRef: ref(call),
        note: `called "${call.name}", which is not in the authorized tool allowlist`,
      });
      continue; // an unauthorized tool is already the worst case; don't also flag its approval state
    }
    if (mustApprove.has(name) && call.approved !== true) {
      findings.push({
        type: "APPROVAL_BYPASS",
        tool: call.name,
        severity: "high",
        callRef: ref(call),
        note: `used "${call.name}" without the required human approval`,
      });
    }
  }
  return findings;
}

/** True iff every tool call respected the policy. */
export function toolsBalanced(calls: ToolCall[], policy: ToolPolicy): boolean {
  return auditTools(calls, policy).length === 0;
}
