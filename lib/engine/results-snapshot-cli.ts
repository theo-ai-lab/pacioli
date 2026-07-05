/**
 * Pacioli — regenerate the reproducible blocks of eval/RESULTS.md.  `npm run eval:snapshot`
 *
 * Offline and keyless, end to end:
 *   - the per-class tables come from the same metrics code as `npm run eval`,
 *   - the fuzz line re-runs the seeded 50k battery,
 *   - the τ²-bench line reads the committed bench/tau2/results.json (no fetch),
 *   - the test counts come from a real vitest run with OLLAMA_URL pointed at an unreachable port, so
 *     the counts are the fully-offline ones even on a machine with a live local Ollama server.
 *
 * CI runs this and then `git diff --exit-code eval/RESULTS.md` — the same regenerate-and-diff gate as
 * the committed benchmark artifacts — so the frozen snapshot can never silently lag the engine.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIncidents, loadSeed } from "./dataset";
import { fuzz } from "./fuzz";
import { evaluate } from "./metrics";
import {
  renderClassTable,
  renderFuzzLine,
  renderTau2Line,
  renderTestsLine,
  replaceBlock,
  type SuiteCounts,
  type Tau2Results,
} from "./results-snapshot";

const RESULTS_PATH = join(process.cwd(), "eval", "RESULTS.md");
const TAU2_PATH = join(process.cwd(), "bench", "tau2", "results.json");

/** Run the suite exactly as CI sees it: keyless, no reachable Ollama. Refuses to snapshot a red suite. */
function runOfflineSuite(): SuiteCounts {
  const outFile = join(tmpdir(), `pacioli-suite-${process.pid}.json`);
  try {
    const res = spawnSync(
      process.execPath,
      [join(process.cwd(), "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json", `--outputFile=${outFile}`],
      { env: { ...process.env, OLLAMA_URL: "http://127.0.0.1:1" }, stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 },
    );
    const report = JSON.parse(readFileSync(outFile, "utf8")) as {
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      testResults: unknown[];
    };
    if (res.status !== 0 || report.numFailedTests > 0)
      throw new Error(`suite is not green (${report.numFailedTests} failed) — fix the tests before snapshotting`);
    return { files: report.testResults.length, passed: report.numPassedTests, skipped: report.numPendingTests };
  } finally {
    rmSync(outFile, { force: true });
  }
}

console.log("PACIOLI — refreshing the reproducible blocks of eval/RESULTS.md (offline, keyless)");

const before = readFileSync(RESULTS_PATH, "utf8");
let doc = before;
doc = replaceBlock(doc, "synthetic", renderClassTable(evaluate(loadSeed())));
doc = replaceBlock(doc, "incidents", renderClassTable(evaluate(loadIncidents())));
doc = replaceBlock(doc, "fuzz", renderFuzzLine(fuzz(50_000, 1234)));
doc = replaceBlock(doc, "tau2", renderTau2Line(JSON.parse(readFileSync(TAU2_PATH, "utf8")) as Tau2Results));
console.log("  running the suite offline for the test-count line…");
doc = replaceBlock(doc, "tests", renderTestsLine(runOfflineSuite()));

if (doc === before) {
  console.log("  ✓ eval/RESULTS.md already matches the engine");
} else {
  writeFileSync(RESULTS_PATH, doc);
  console.log("  updated eval/RESULTS.md — review the diff, then commit (CI diffs this file on every push)");
}
