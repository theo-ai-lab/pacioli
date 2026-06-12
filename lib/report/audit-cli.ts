/**
 * Pacioli — audit CLI. Reconciles a JSONL corpus of {claim, evidence} pairs and emits machine-readable
 * SARIF or JUnit, so the engine can gate a CI pipeline (the "prevent" role).
 *
 *   tsx lib/report/audit-cli.ts [--format sarif|junit] [--out file] [--gate] [corpus.jsonl]
 *
 * With no file it audits the in-repo seed + public-incident corpus as a demo. `--gate` exits non-zero
 * if any claim was flagged (use it in CI to fail the build on agent misbehavior).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { audit, toCase, summarize, type AuditCase } from "./audit";
import { toSarif } from "./sarif";
import { toJUnit } from "./junit";
import { loadSeed, loadIncidents } from "../engine/dataset";

const args = process.argv.slice(2);
const fmtIdx = args.indexOf("--format");
const outIdx = args.indexOf("--out");
const fmtValue = fmtIdx >= 0 ? args[fmtIdx + 1] : undefined;
if (fmtValue !== undefined && fmtValue !== "sarif" && fmtValue !== "junit") {
  // A typo'd format must not silently emit the wrong report into a CI consumer expecting the other.
  process.stderr.write(`pacioli audit · unknown --format "${fmtValue}" (expected: sarif | junit)\n`);
  process.exit(2);
}
const format = fmtValue ?? "sarif";
const gate = args.includes("--gate");
const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
const valueIdxs = new Set([fmtIdx, outIdx].filter((i) => i >= 0).map((i) => i + 1));
const file = args.find((a, i) => !a.startsWith("--") && !valueIdxs.has(i));

let cases: AuditCase[];
let malformed = 0;
if (file) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => toCase(JSON.parse(l), i));
  cases = rows.filter((c): c is AuditCase => c !== null);
  malformed = rows.length - cases.length;
} else {
  const rows = [...loadSeed(), ...loadIncidents()].map((s, i) => toCase(s, i));
  cases = rows.filter((c): c is AuditCase => c !== null);
  malformed = rows.length - cases.length;
}
if (malformed > 0) {
  // A skipped row is an UNAUDITED claim — silent skipping would be a false negative in the gate.
  process.stderr.write(`pacioli audit · WARNING: ${malformed} malformed row(s) skipped (type-invalid claim/evidence) — fix or remove them\n`);
}

const results = audit(cases);
const report = (format === "junit" ? toJUnit(results) : JSON.stringify(toSarif(results), null, 2)) + "\n";
if (outFile) writeFileSync(outFile, report);
else process.stdout.write(report);

const s = summarize(results);
process.stderr.write(
  `pacioli audit · ${s.cases} cases · ${s.flagged} flagged · ${s.findings} findings · ${s.unscorable} unscored\n`,
);
// A malformed row is an UNAUDITED claim — under --gate that is a failure, not just a warning.
if (gate && (s.flagged > 0 || malformed > 0)) process.exit(1);
