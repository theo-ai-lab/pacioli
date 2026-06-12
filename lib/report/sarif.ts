/**
 * Pacioli — SARIF 2.1.0 reporter.
 *
 * Maps each finding to a SARIF result so a reconciliation can be uploaded as a code-scanning report
 * (GitHub "Code scanning", or any SARIF viewer). One rule per finding class; severity → SARIF level.
 */
import type { AuditResult } from "./audit";
import { ENGINE_VERSION } from "./audit";
import { FINDING_TYPES, type FindingType, type Severity } from "../engine/types";

// Keyed by FindingType so a fifth finding class FAILS THE BUILD here instead of emitting SARIF
// results whose ruleId references no declared rule (the runtime-derivation contract in types.ts).
const RULE_META: Record<FindingType, { name: string; short: string }> = {
  OVERSPEND: { name: "Overspend", short: "Charged more than the authorized budget." },
  SCOPE_CREEP: { name: "ScopeCreep", short: "Did more than was authorized." },
  UNAUTH_RECURRENCE: { name: "UnauthorizedRecurrence", short: "Started a recurring charge that was not authorized." },
  CLAIM_MISMATCH: { name: "ClaimMismatch", short: "The agent's stated outcome contradicts the evidence." },
};
const RULES = FINDING_TYPES.map((id) => ({ id, ...RULE_META[id] }));

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
};

export interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: unknown[];
  properties: Record<string, unknown>;
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        rules: Array<{ id: string; name: string; shortDescription: { text: string } }>;
      };
    };
    results: SarifResult[];
  }>;
}

export function toSarif(results: AuditResult[]): SarifLog {
  const sarifResults: SarifResult[] = results.flatMap((r) =>
    r.verdict.findings.map((f) => ({
      ruleId: f.type,
      level: LEVEL[f.severity],
      message: { text: f.note },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: `claim/${encodeURIComponent(r.id)}` }, // untrusted id — encode so it can't smuggle path traversal / schemes into SARIF consumers
            region: { startLine: 1, snippet: { text: f.claimedRef } },
          },
          logicalLocations: [{ name: r.id, kind: "namespace" }],
        },
      ],
      properties: {
        dimension: f.dimension,
        severity: f.severity,
        claimedRef: f.claimedRef,
        actualRef: f.actualRef,
        llmAssisted: f.llmAssisted,
        agent: r.input.claim.agent,
        merchant: r.input.evidence.merchant,
        deltaUsd: r.verdict.deltaUsd,
      },
    })),
  );

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Pacioli",
            version: ENGINE_VERSION,
            rules: RULES.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.short },
            })),
          },
        },
        results: sarifResults,
      },
    ],
  };
}
