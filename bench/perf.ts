/**
 * Pacioli — engine performance benchmark + regression gate.
 *
 * Times the deterministic engine over the in-repo corpus and reports latency percentiles + throughput.
 * `--gate` fails if p95 per-call latency exceeds a ceiling (default 1.0 ms) — a cheap guard against a
 * change that accidentally makes the hot path slow. Run: `npm run bench:perf` (add `--gate` in CI).
 */
import { performance } from "node:perf_hooks";
import { diff } from "@pacioli-app/engine";
import { loadSeed, loadIncidents } from "../lib/engine/dataset";

const corpus = [...loadSeed(), ...loadIncidents()].map((s) => s.input);
const ITER = 2000;
const CEILING_MS = 1.0;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// warm up the JIT so the measurement reflects steady state
for (let w = 0; w < 200; w++) for (const input of corpus) diff(input);

const perCall: number[] = [];
for (let i = 0; i < ITER; i++) {
  for (const input of corpus) {
    const t0 = performance.now();
    diff(input);
    perCall.push(performance.now() - t0);
  }
}
perCall.sort((a, b) => a - b);

const mean = perCall.reduce((s, x) => s + x, 0) / perCall.length;
const us = (ms: number) => `${(ms * 1000).toFixed(1)}µs`;

process.stdout.write(
  `pacioli engine perf · ${corpus.length} cases × ${ITER} iters (${perCall.length} calls)\n` +
    `  mean ${us(mean)} · p50 ${us(percentile(perCall, 50))} · p95 ${us(percentile(perCall, 95))} · ` +
    `p99 ${us(percentile(perCall, 99))} · ~${Math.round(1000 / mean).toLocaleString()} calls/sec\n`,
);

if (process.argv.includes("--gate") && percentile(perCall, 95) > CEILING_MS) {
  process.stderr.write(`PERF REGRESSION: p95 ${us(percentile(perCall, 95))} exceeds ${CEILING_MS}ms ceiling\n`);
  process.exit(1);
}
