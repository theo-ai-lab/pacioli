/**
 * Pacioli — JUnit XML reporter.
 *
 * One <testcase> per reconciled claim: a balanced verdict passes, a flagged claim gets ONE <failure>
 * element carrying every finding, and missing/late evidence is <skipped> (never a silent pass). Lets
 * the engine drop into any CI that reads JUnit. Deterministic by default (fixed timestamp) so the
 * output is reproducible in tests.
 */
import type { AuditResult } from "./audit";

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // control chars are illegal in XML 1.0 even escaped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toJUnit(results: AuditResult[], opts?: { timestamp?: string }): string {
  const tests = results.length;
  // Unscorable results render as <skipped> (never <failure>), so they must not inflate failures="N"
  // — suite attributes always agree with the rendered elements.
  const failures = results.filter((r) => !r.verdict.unscorable && r.verdict.findings.length > 0).length;
  const skipped = results.filter((r) => r.verdict.unscorable).length;
  const ts = opts?.timestamp ?? "1970-01-01T00:00:00Z";

  const cases = results.map((r) => {
    const name = esc(r.id);
    if (r.verdict.unscorable) {
      return `    <testcase name="${name}" classname="pacioli.reconcile"><skipped message="insufficient evidence"/></testcase>`;
    }
    if (r.verdict.findings.length === 0) {
      return `    <testcase name="${name}" classname="pacioli.reconcile"/>`;
    }
    // ONE <failure> element per failing testcase (CI consumers count failure ELEMENTS; the suite-level
    // failures="N" counts failing CASES — emitting one element per finding would make them disagree).
    const fs = r.verdict.findings;
    const msg = fs.length === 1 ? fs[0].note : `${fs.length} findings: ${fs.map((f) => f.type).join(", ")}`;
    const detail = fs.map((f) => `[${f.type}] ${f.note}: ${f.claimedRef} ≠ ${f.actualRef}`).join("\n");
    const fail = `      <failure type="${esc(fs[0].type)}" message="${esc(msg)}">${esc(detail)}</failure>`;
    return `    <testcase name="${name}" classname="pacioli.reconcile">\n${fail}\n    </testcase>`;
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    // No skipped attr on <testsuites> (not in the common JUnit XSDs); errors="0" declared explicitly.
    `<testsuites name="pacioli-audit" tests="${tests}" failures="${failures}" errors="0">`,
    `  <testsuite name="pacioli-audit" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}" timestamp="${ts}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
}
