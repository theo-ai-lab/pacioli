/**
 * Emits eval/dataset.jsonl for the Inspect AI harness.  `npm run eval:build`
 *
 * The TypeScript engine is the SINGLE classifier. This script runs it over the
 * labeled synthetic fixtures and writes, per row, the gold label set and the
 * engine's predicted set. The Python harness (eval/discrepancy_eval.py) then only
 * SCORES gold vs predicted — it never re-implements the engine.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diff } from "@pacioli-app/engine";
import { loadSeed } from "./dataset";

const rows = loadSeed().filter((r) => !r.target.unscorable);

const out = rows.map((r) => {
  const pred = diff(r.input);
  const gold = Array.from(new Set((r.target.findings ?? []).map((f) => f.type))).sort();
  const predicted = Array.from(new Set(pred.findings.map((f) => f.type))).sort();
  const text =
    `${r.input.claim.agent}: "${r.input.claim.text}" → ${r.input.evidence.merchant}: ${r.input.evidence.excerpt}`.slice(
      0,
      260,
    );
  return { id: r.id, text, gold, predicted, balanced_gold: r.target.balanced, balanced_pred: pred.balanced };
});

const dir = join(process.cwd(), "eval");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "dataset.jsonl"), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`wrote eval/dataset.jsonl — ${out.length} scorable rows (predictions from the TypeScript engine)`);
