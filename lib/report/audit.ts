/**
 * Pacioli — audit core for machine-readable CI output.
 *
 * Runs the deterministic engine over a corpus of (claim, evidence) pairs and exposes the verdicts in
 * a shape the SARIF / JUnit reporters can serialize — so the same engine that prints a receipt can also
 * GATE a CI pipeline (the "prevent" role). Pure: just diff() over a list, no IO here.
 */
import { diff } from "../engine/diff";
import type { DiffInput, Verdict } from "../engine/types";

/** Surfaced as the audit tool version in SARIF/JUnit. Bump when rule behavior changes. */
export const ENGINE_VERSION = "0.1.0";

export interface AuditCase {
  id: string;
  input: DiffInput;
}

export interface AuditResult {
  id: string;
  input: DiffInput;
  verdict: Verdict;
}

/** Runtime-validate the fields the rule engine actually branches on. A blind cast would let a
 *  malformed row (e.g. `"amountUsd":"9999"` — a string) silently dodge the numeric overspend rule:
 *  a false NEGATIVE in the CI gate. Invalid rows are rejected (null) so the CLI can report them. */
function isReconcilable(v: unknown): v is DiffInput {
  if (!v || typeof v !== "object") return false;
  const { claim, evidence } = v as { claim?: unknown; evidence?: unknown };
  if (!claim || typeof claim !== "object" || !evidence || typeof evidence !== "object") return false;
  const c = claim as Record<string, unknown>;
  const e = evidence as Record<string, unknown>;
  if (typeof c.text !== "string" || typeof c.task !== "string") return false;
  if (c.authorized !== undefined && (c.authorized === null || typeof c.authorized !== "object")) return false;
  const budget = (c.authorized as Record<string, unknown> | undefined)?.budgetUsd;
  if (!(budget === undefined || budget === null || typeof budget === "number")) return false;
  if (typeof e.merchant !== "string") return false;
  if (!(e.amountUsd === undefined || e.amountUsd === null || typeof e.amountUsd === "number")) return false;
  // Elements must be strings too — a numeric item crashes the engine's toLowerCase() downstream.
  if (!(e.items === undefined || (Array.isArray(e.items) && e.items.every((x) => typeof x === "string")))) return false;
  if (!(e.recurring === undefined || typeof e.recurring === "boolean")) return false;
  if (!(e.excerpt === undefined || typeof e.excerpt === "string")) return false;
  return true;
}

/** Normalize a loosely-shaped row — {id?, input:{claim,evidence}} or {id?, claim, evidence} — into an
 *  AuditCase, or null if it isn't a VALID reconcilable pair (shape-checked, not cast — see above). */
export function toCase(row: unknown, index: number): AuditCase | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { id?: unknown; input?: { claim?: unknown; evidence?: unknown }; claim?: unknown; evidence?: unknown };
  const candidate: unknown =
    r.input?.claim && r.input?.evidence ? r.input : r.claim && r.evidence ? { claim: r.claim, evidence: r.evidence } : null;
  if (!candidate || !isReconcilable(candidate)) return null;
  return { id: typeof r.id === "string" ? r.id : `case-${index + 1}`, input: candidate };
}

export function audit(cases: AuditCase[]): AuditResult[] {
  return cases.map((c) => ({ id: c.id, input: c.input, verdict: diff(c.input) }));
}

export interface AuditSummary {
  cases: number;
  flagged: number;
  findings: number;
  unscorable: number;
}

export function summarize(results: AuditResult[]): AuditSummary {
  let flagged = 0;
  let findings = 0;
  let unscorable = 0;
  for (const r of results) {
    if (r.verdict.unscorable) unscorable++;
    if (r.verdict.findings.length) {
      flagged++;
      findings += r.verdict.findings.length;
    }
  }
  return { cases: results.length, flagged, findings, unscorable };
}
