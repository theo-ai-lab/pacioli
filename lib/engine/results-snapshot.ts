/**
 * Pacioli — rendering for the reproducible blocks of eval/RESULTS.md.  (CLI: results-snapshot-cli.ts)
 *
 * eval/RESULTS.md is a frozen, human-voiced snapshot, and frozen snapshots rot: the numbers must never
 * silently lag the engine. The content between `<!-- repro:begin NAME -->` / `<!-- repro:end NAME -->`
 * markers is machine-rendered by these functions so CI can regenerate it and fail on any drift
 * (`npm run eval:snapshot && git diff --exit-code eval/RESULTS.md`). Sections that need an API key or
 * real captured runs (the LLM judge, the headline misbehavior rate) carry no markers and are never
 * rewritten — their pending labels are the honest state, not staleness.
 */

import type { EvalReport } from "./metrics";
import type { FuzzResult } from "./fuzz";

/** Markdown cell for a possibly-undefined ratio: `—` when the engine never predicts the class (no
 *  precision denominator) or the labeled set has no positives (no recall denominator). */
const cell = (x: number | null): string => (x == null ? "—" : x.toFixed(2));

/** The per-class table plus row/balanced summary, exactly as frozen in eval/RESULTS.md. */
export function renderClassTable(r: EvalReport): string {
  const labeled = r.n + r.unscored;
  const unscored = r.unscored ? `, ${r.unscored} unscored` : "";
  return [
    `${labeled} labeled rows (${r.n} scorable${unscored}).`,
    "",
    "| class | precision | recall | tp/fp/fn | support |",
    "|---|---:|---:|---|---:|",
    ...r.perClass.map(
      (m) => `| \`${m.type}\` | ${cell(m.precision)} | ${cell(m.recall)} | ${m.tp}/${m.fp}/${m.fn} | ${m.support} |`,
    ),
    "",
    `balanced/out-of-balance classified correctly: ${r.balancedCorrect}/${r.balancedTotal}.`,
  ].join("\n");
}

export function renderFuzzLine(res: FuzzResult): string {
  return (
    `- \`npm run fuzz\` → ${res.cases.toLocaleString("en-US")} mutated cases, seed ${res.seed}: ` +
    `**${res.determinismFailures} determinism failures, ${res.failures.length} invariant violations**.`
  );
}

/** The fields this snapshot needs from bench/tau2/results.json (written by `npm run bench:tau2`). */
export interface Tau2Results {
  tasksAdapted: number;
  inScopeCases: number;
  falsePositives: number;
}

/** Derived from the COMMITTED bench/tau2/results.json — regenerating that file fetches the upstream
 *  task data (`npm run bench:tau2`) and stays a manual, network step; this line only has to agree
 *  with what is checked in. */
export function renderTau2Line(t: Tau2Results): string {
  return (
    `- \`npm run bench:tau2\` → ${t.tasksAdapted} τ²-bench tasks: **${t.falsePositives}/${t.inScopeCases} false positives** ` +
    "on in-scope trajectories — a specificity check; money dimensions are not validated and violation " +
    "amounts are constructed (see [`bench/tau2/results.json`](../bench/tau2/results.json))."
  );
}

export interface SuiteCounts {
  files: number;
  passed: number;
  skipped: number;
}

export function renderTestsLine(c: SuiteCounts): string {
  return (
    `- \`npm test\` → ${c.files} files, **${c.passed} passed / ${c.skipped} skipped** ` +
    "(fully offline: the optional live-Ollama and post-quantum-dep paths skip)."
  );
}

/** Replace the body between the named repro markers. Throws on missing, out-of-order, or duplicated
 *  markers so a damaged RESULTS.md fails loudly instead of silently keeping stale numbers. */
export function replaceBlock(doc: string, name: string, body: string): string {
  const begin = `<!-- repro:begin ${name} -->`;
  const end = `<!-- repro:end ${name} -->`;
  const i = doc.indexOf(begin);
  const j = doc.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`RESULTS.md: missing repro markers for "${name}"`);
  if (j < i) throw new Error(`RESULTS.md: end marker precedes begin marker for "${name}"`);
  if (doc.indexOf(begin, i + 1) !== -1 || doc.indexOf(end, j + 1) !== -1)
    throw new Error(`RESULTS.md: duplicate repro markers for "${name}"`);
  return doc.slice(0, i + begin.length) + "\n" + body + "\n" + doc.slice(j);
}
