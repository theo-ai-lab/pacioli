/**
 * Pacioli — the reconcile CLI: cascade-equivalence, sample-k saturation, and the conformal residual band.
 *
 *   npm run reconcile -- --equivalence [--policy trust-on-resolve|trust-all] [--judge auto|local|anthropic]
 *   npm run reconcile -- --saturation
 *   npm run reconcile -- --conformal [--alpha 0.1]
 *
 * DEFAULT IS KEYLESS. `--equivalence` runs the deterministic-vs-deterministic regression with the
 * GOLD-ORACLE judge (the human labels stand in for a perfect expensive tier) — zero model spend, the CI
 * path. The full judge-equivalence CALIBRATION (does the REAL judge respect the no-overturn assumption
 * the lossless guarantee rests on?) is the one-time GATED pass: pass `--judge anthropic|local|auto`; with
 * no key / no Ollama it is SKIPPED honestly and the keyless gold-oracle regression runs in its place.
 */

import { diff } from "./diff";
import { loadSeed, loadIncidents } from "./dataset";
import {
  cascadeMetrics,
  CLAIM_CASCADE,
  equivCascadeViolations,
  goldOracleJudge,
  telemetrySlice,
  type CascadePolicy,
  type JudgeFn,
} from "./cascade";
import { buildCascadeReceipt } from "./cascade-receipt";
import { merkleRoot, merkleProof, verifyProof } from "./merkle";
import { receiptHash } from "./receipt-hash";
import { resolveJudge, type JudgeMode } from "./judge-router";
import { saturationCurve, syntheticJudgeInstrument } from "./saturation";
import {
  evaluateCoverage,
  fitConformalBand,
  mismatchScore,
  splitCalibTest,
  type LabeledScore,
} from "./conformal";
import type { DiffInput, GroundTruthSample } from "./types";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const goldIsClaimMismatch = (r: GroundTruthSample): boolean =>
  (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");
const isResidual = (r: GroundTruthSample): boolean => diff(r.input).findings.length === 0;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function corpus(): GroundTruthSample[] {
  return [...loadSeed(), ...loadIncidents()];
}

/** Resolve the expensive tier: a REAL gated judge if requested AND available, else the keyless
 *  gold-oracle (honest fallback, never a fake live run). */
async function resolveExpensive(rows: GroundTruthSample[]): Promise<{ judge: JudgeFn; label: string }> {
  const sel = value("--judge") as JudgeMode | undefined;
  if (!sel) return { judge: goldOracleJudge(rows), label: "gold-oracle" };
  const resolved = await resolveJudge(sel);
  if (resolved.available && resolved.mode !== "off") {
    return { judge: resolved.judge, label: resolved.mode };
  }
  console.log(
    `\n  NOTE: --judge ${sel} is UNAVAILABLE (no key / no Ollama). The gated judge-equivalence calibration is` +
      `\n  SKIPPED by design — running the keyless gold-oracle regression instead (zero model spend).`,
  );
  return { judge: goldOracleJudge(rows), label: "gold-oracle" };
}

async function runEquivalence(): Promise<void> {
  const rows = corpus();
  const inputs: DiffInput[] = rows.map((r) => r.input);
  const policy = (value("--policy", "trust-on-resolve") as CascadePolicy) ?? "trust-on-resolve";
  const { judge, label } = await resolveExpensive(rows);

  console.log("\nPacioli — CASCADE EQUIVALENCE (the deterministic fast path, made falsifiable)");
  console.log(`\n  boundary : ${CLAIM_CASCADE.id}`);
  console.log(`  cheap    : ${CLAIM_CASCADE.cheap.name}`);
  console.log(`             regime=${CLAIM_CASCADE.cheap.regime}  locus=${CLAIM_CASCADE.cheap.locus}`);
  console.log(`  expensive: ${CLAIM_CASCADE.expensive.name}`);
  console.log(`             regime=${CLAIM_CASCADE.expensive.regime}  locus=${CLAIM_CASCADE.expensive.locus}`);
  console.log(`  judge    : ${label}${label === "gold-oracle" ? " (keyless; human labels = perfect expensive tier)" : " (LIVE, gated)"}`);

  const m = await cascadeMetrics(inputs, judge, { policy, judgeLabel: label });
  console.log(`\n  measured over n=${m.n} labeled fixtures (seed + documented incidents), policy=${m.policy}:`);
  console.log(`    alpha (cheap tier resolves losslessly, no escalation) : ${pct(m.alpha)}`);
  console.log(`    escalationRate (expensive tier touches the residual)  : ${pct(m.escalationRate)}`);
  console.log(`    disagreementRate (both run, verdict class differs)    : ${pct(m.disagreementRate)}`);
  console.log(`    losslessViolations (cascade class ≠ expensive-on-all) : ${m.losslessViolations}`);
  console.log(`    skippedResidualFindings (disclosed completeness cost) : ${m.skippedResidualFindings}`);

  const violations = await equivCascadeViolations(inputs, judge, policy);
  console.log(`\n  EQUIV-CASCADE: ${violations.length === 0 ? "HOLDS (0 class violations)" : `${violations.length} VIOLATION(S)`}`);

  // Prove the relation can BITE: the deliberately lossy "trust-all" baseline must produce violations,
  // else the safe-policy 0 would be vacuous.
  const lossy = await cascadeMetrics(inputs, judge, { policy: "trust-all", judgeLabel: label });
  console.log(
    `  contrast: the LOSSY "trust-all" baseline (never escalate) yields ${lossy.losslessViolations} ` +
      `lossless violation(s) — so the safe-policy 0 is meaningful, not vacuous.`,
  );

  console.log(`\n  suite telemetry slice: ${JSON.stringify(telemetrySlice(m))}`);

  // Commit the equivalence relation into the SAME Merkle audit trail as the receipts it summarizes.
  const receipt = await buildCascadeReceipt(m);
  const receiptLeaves = await Promise.all(inputs.slice(0, 4).map((i) => receiptHash(i, diff(i))));
  const leaves = [...receiptLeaves, receipt.leafHash];
  const root = await merkleRoot(leaves);
  const idx = leaves.length - 1;
  const ok = await verifyProof(receipt.leafHash, await merkleProof(leaves, idx), root);
  console.log(`\n  cascade receipt id : ${receipt.receiptId}`);
  console.log(`  committed to Merkle root ${root.slice(0, 16)}… (inclusion proof verifies: ${ok})`);
}

function runSaturation(): void {
  const residual = corpus().filter(isResidual);
  const goldFlags = residual.map(goldIsClaimMismatch);
  const instrument = syntheticJudgeInstrument(goldFlags);
  const curve = saturationCurve(instrument);

  console.log("\nPacioli — judge SAMPLE-k SATURATION curve (FIXED gold set; sample-k axis only)");
  console.log(
    "\n  SIMULATED stochastic-judge instrument — NOT a measurement of any real judge. With a key, replace" +
      "\n  the per-row flip-probabilities with empirical frequencies from k live judge samples.",
  );
  console.log(`\n  fixed residual set n=${curve.n} (rows the deterministic tier abstains on)`);
  console.log("\n    k     majority-vote accuracy vs gold    gain");
  for (const p of curve.points) {
    console.log(`   ${String(p.k).padStart(3)}    ${p.accuracy.toFixed(4)}                        ${p.gain >= 0 ? "+" : ""}${p.gain.toFixed(4)}`);
  }
  console.log(`\n  asymptote (k→∞ consensus accuracy)        : ${curve.asymptote.toFixed(4)}`);
  console.log(`  irreducibleAmbiguity (coin-flip gold rows): ${pct(curve.irreducibleAmbiguity)} — the floor sampling cannot pass`);
  console.log(`  saturationK (within tol of the asymptote) : ${curve.saturationK ?? "not reached in grid"}`);
}

function runConformal(): void {
  const alpha = Number(value("--alpha", "0.1"));
  const residual = corpus().filter(isResidual);
  const scored: LabeledScore[] = residual.map((r) => ({ score: mismatchScore(r.input).score, gold: goldIsClaimMismatch(r) }));
  const { calib, test } = splitCalibTest(scored, 0.5, 1234);
  const band = fitConformalBand(calib, alpha);
  const report = evaluateCoverage(test, band);

  console.log("\nPacioli — CONFORMAL residual band on CLAIM_MISMATCH (locus = the claim)");
  console.log(`\n  keyless mismatch-score proxy → split conformal at alpha=${alpha} (target coverage ≥ ${pct(1 - alpha)})`);
  console.log(`  calibration: ${calib.length} rows (${band.nOk} ok / ${band.nMismatch} mismatch)  ·  held-out test: ${test.length} rows`);
  const degenerate = band.tauLo >= band.tauHi;
  console.log(`\n  band: s ≤ ${band.tauLo.toFixed(3)} → confidently OK   ·   s ≥ ${band.tauHi.toFixed(3)} → confidently MISMATCH`);
  if (degenerate) {
    console.log(`        the OK and MISMATCH zones OVERLAP → every claim is ambiguous → ESCALATE everything (safe).`);
  } else {
    console.log(`        ${band.tauLo.toFixed(3)} < s < ${band.tauHi.toFixed(3)} → ESCALATE (the residual the judge touches)`);
  }
  console.log(`\n  held-out (scored ONCE):`);
  console.log(`    empirical coverage : ${pct(report.coverage)}  (Wilson 95% CI ${pct(report.coverageCI.low)}–${pct(report.coverageCI.high)})`);
  console.log(`    escalationRate     : ${pct(report.escalationRate)}   trustRate: ${pct(report.trustRate)}`);
  console.log(`    selectiveAccuracy  : ${report.selectiveAccuracy == null ? "n/a (nothing resolved)" : pct(report.selectiveAccuracy)}`);
  console.log(
    `\n  HONEST READ: n is in the tens, so the conformal guarantee is WIDE (see the CI) and the proxy is` +
      `\n  crude. The residual is overwhelmingly CLAIM_MISMATCH (only ${band.nOk} OK calibration row(s)) — exactly the` +
      `\n  repo's thesis that real agent failures are mostly claim-mismatches — so conformal cannot safely certify` +
      `\n  an OK trust zone and escalates everything (the safe failure, never false trust). The methodology is the` +
      `\n  deliverable; calibrate at one alpha (scanning would need Bonferroni/BH).`,
  );
}

async function main(): Promise<void> {
  if (flag("--saturation")) return runSaturation();
  if (flag("--conformal")) return runConformal();
  // default + explicit --equivalence
  await runEquivalence();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
