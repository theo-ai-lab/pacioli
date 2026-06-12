/**
 * Pacioli — dev eval CLI.  `npm run eval`
 *
 * Prints PER-CLASS precision/recall for the deterministic engine, kept strictly
 * apart by the provenance firewall:
 *   1. DETECTOR ACCURACY — does the engine reproduce the labels? (synthetic + incidents)
 *   2. AGENT-MISBEHAVIOR RATE (the headline) — of REAL commissioned runs, how many
 *      misbehaved? Synthetic never counts. The credible, citable version of (1) is
 *      produced by the Inspect AI harness (eval/discrepancy_eval.py); this CLI is the
 *      fast dev-loop view over the same metrics code (lib/engine/metrics.ts).
 */

import { evaluate, type ClassMetric } from "./metrics";
import { loadSeed, loadIncidents, loadCaptured } from "./dataset";
import { isHeadlineEligible, type GroundTruthSample } from "./types";

const pct = (x: number | null): string => (x == null ? "  –  " : x.toFixed(2));
const cell = (m: ClassMetric): string =>
  `${m.type.padEnd(20)} ${pct(m.precision)}  ${pct(m.recall)}    ${String(m.tp).padStart(2)} ${String(
    m.fp,
  ).padStart(2)} ${String(m.fn).padStart(2)}    ${m.support}`;

function table(title: string, rows: GroundTruthSample[]): void {
  const r = evaluate(rows);
  console.log(`\n=== ${title}  (${rows.length} rows) ===`);
  console.log("class                prec  recall   tp fp fn   support");
  for (const m of r.perClass) console.log(cell(m));
  const tail = r.unscored ? `  (${r.unscored} unscored, excluded)` : "";
  console.log(`balanced/out-of-balance classified correctly: ${r.balancedCorrect}/${r.balancedTotal}${tail}`);
}

console.log("PACIOLI — diff engine eval (deterministic v1; CLAIM_MISMATCH is the LLM residual, abstained by design)");

table("DETECTOR ACCURACY · synthetic fixtures", loadSeed());
table("DETECTOR ACCURACY · public incidents", loadIncidents());

console.log("\n----------------------------------------------------------------");
const real = loadCaptured().filter(isHeadlineEligible);
const misbehaved = real.filter((r) => !r.target.balanced && !r.target.unscorable).length;
console.log(`HEADLINE — AGENT-MISBEHAVIOR RATE (real commissioned runs only): ${misbehaved}/${real.length} misbehaved`);
if (real.length < 10) {
  const qualifier = real.length === 0 ? "" : misbehaved === 0 ? ", all balanced controls" : "";
  console.log(
    `  (only ${real.length} real run(s) so far${qualifier} — the real headline number needs live-card captures; synthetic must never fill this in)`,
  );
}
