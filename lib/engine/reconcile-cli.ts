/**
 * Pacioli — the reconcile CLI: cascade-equivalence, sample-k saturation, the conformal residual band,
 * judge→floor distillation, and the residual judge's selective-risk certificate.
 *
 *   npm run reconcile -- --equivalence [--policy trust-on-resolve|trust-all] [--judge auto|local|anthropic]
 *   npm run reconcile -- --saturation
 *   npm run reconcile -- --conformal [--alpha 0.1]
 *   npm run reconcile -- --distill   [--judge auto|local|anthropic] [--seed N]
 *   npm run reconcile -- --certify   [--judge auto|local|anthropic] [--delta 0.05]
 *
 * DEFAULT IS KEYLESS. `--equivalence` runs the deterministic-vs-deterministic regression with the
 * GOLD-ORACLE judge (the human labels stand in for a perfect expensive tier) — zero model spend, the CI
 * path. The full judge-equivalence CALIBRATION (does the REAL judge respect the no-overturn assumption
 * the lossless guarantee rests on?) is the one-time GATED pass: pass `--judge anthropic|local|auto`; with
 * no key / no Ollama it is SKIPPED honestly and the keyless gold-oracle regression runs in its place.
 *
 * `--distill` and `--certify` both default to the KEYLESS mock JURY (jury.ts); `--judge` seeds a REAL jury
 * from the distinct available backends and falls back honestly to the mock when fewer than two exist.
 */

import { diff } from "@pacioli-app/engine";
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
import { merkleRoot, merkleProof, verifyProof } from "@pacioli-app/engine";
import { receiptHash } from "@pacioli-app/engine";
import { resolveJudge, type JudgeMode } from "./judge-router";
import { saturationCurve, syntheticJudgeInstrument } from "./saturation";
import {
  evaluateCoverage,
  fitConformalBand,
  mismatchScore,
  splitCalibTest,
  type LabeledScore,
} from "./conformal";
import {
  mockJury,
  runJury,
  seedRealJury,
  isHighConsensusMismatch,
  DEFAULT_CONSENSUS_GATE,
  type Juror,
} from "./jury";
import { applyPromotedRules, distillRules } from "./distill";
import { buildPromotionLedger, provePromotion, verifyPromotionInclusion } from "./distill-receipt";
import { certifySelectiveRisk, widthVsN, type SelectiveItem } from "./selective-risk";
import type { DiffInput, GroundTruthSample } from "@pacioli-app/engine";

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

/** Resolve the JURY: a REAL panel from the distinct available backends if `--judge` is given AND ≥2 exist,
 *  else the keyless mock jury (honest fallback, never a fabricated or padded panel). */
async function resolveJury(): Promise<{ jurors: Juror[]; label: string; note: string }> {
  const sel = value("--judge");
  if (sel) {
    const seed = await seedRealJury();
    if (seed.isJury) return { jurors: seed.jurors, label: `real (${seed.available.join("+")})`, note: seed.note };
    console.log(`\n  NOTE: --judge ${sel} requested but ${seed.note}.\n  Running the KEYLESS mock jury instead (zero model spend).`);
  }
  return {
    jurors: mockJury(),
    label: "mock (keyless)",
    note: "4 facet jurors reading distinct facets of the keyless proxy — a synthetic sizing instrument, not a real model",
  };
}

async function runDistill(): Promise<void> {
  const all = corpus();
  const residual = all.filter(isResidual);
  const { jurors, label, note } = await resolveJury();
  const consensus = await runJury(jurors, residual.map((r) => r.input));
  const seed = Number(value("--seed", "7"));
  const result = distillRules(residual, consensus, all.length, { splitSeed: seed });

  console.log("\nPacioli — DISTILL THE JUDGE INTO THE DETERMINISTIC FLOOR (jury → holdout-gated → promoted rule)");
  console.log(`\n  jury     : ${label} — ${note}`);
  console.log(
    `             m=${consensus.m} jurors, mean pairwise correlation ρ̄=${consensus.meanPairwiseCorrelation.toFixed(3)}, ` +
      `effectiveJurors=${consensus.effectiveJurors.toFixed(2)} (correlation-corrected, NOT the member count)`,
  );
  console.log(`  residual : ${result.n} claims the deterministic tier abstains on; split derivation ${result.derivationN} / holdout ${result.holdoutN} (seed ${seed})`);

  console.log("\n  candidate atoms — PROPOSE on the jury's high-consensus agreements, DISPOSE on GOLD out of sample:");
  for (const c of result.candidates) {
    const verdict = c.promoted ? "PROMOTED" : c.derivation.passed ? "REJECTED" : "not proposed";
    console.log(`\n    ${c.atom}  →  ${verdict}`);
    console.log(
      `        derivation: explains ${c.derivation.agreedMismatch}/${c.derivation.firesOn} of its fires as high-consensus agreements` +
        ` (precision ${c.derivation.precision == null ? "n/a" : pct(c.derivation.precision)}); proposed=${c.derivation.passed}`,
    );
    console.log(`        holdout   : ${c.holdout.reason}`);
    console.log(`        why       : ${c.explanation}`);
  }

  console.log(`\n  PROMOTED into the always-on deterministic ruleset: ${result.promoted.length} rule(s)`);
  for (const p of result.promoted) console.log(`    ${p.ruleId}  (${p.type})`);

  const r = result.replaceable;
  const cov = result.coverage;
  console.log("\n  REPLACEABLE FRACTION — the judge calls the deterministic floor now absorbs:");
  console.log(`    out-of-sample (holdout) estimate : ${pct(r.replaceableFractionHoldout)}  (${r.holdoutResolved} of ${r.holdoutN} held-out residual rows)`);
  console.log(`    operational (full residual)      : ${pct(r.replaceableFractionFull)}  (${r.fullResolved} of ${result.n} residual rows)`);
  console.log(`    deterministic coverage           : ${pct(cov.deterministicCoverageBefore)} → ${pct(cov.deterministicCoverageAfter)}  (of all ${cov.corpusN} labeled claims)`);
  console.log(`    residual judge-call rate         : ${pct(cov.residualJudgeRateBefore)} → ${pct(cov.residualJudgeRateAfter)}`);
  console.log(
    "\n  HONEST READ: the out-of-sample holdout number is the defensible one; the operational number is what the\n" +
      "  shipped ruleset catches on this corpus. Only rules that hit the GOLD precision floor on a slice they were\n" +
      "  NOT derived from are promoted — a candidate the jury agreed on but gold rejects out of sample is dropped.",
  );

  // Merkle-commit the promoted ruleset into the audit trail.
  const ledger = await buildPromotionLedger(result.promoted);
  console.log(`\n  promotion ledger Merkle root ${ledger.root.slice(0, 16)}… (${result.promoted.length} leaf/leaves)`);
  if (result.promoted.length > 0) {
    const proof = await provePromotion(ledger, 0);
    const ok = await verifyPromotionInclusion(ledger.leaves[0], proof, ledger.root);
    console.log(`  inclusion proof for ${result.promoted[0].ruleId} verifies: ${ok}`);
  }
}

async function runCertify(): Promise<void> {
  const all = corpus();
  const residual = all.filter(isResidual);
  const delta = Number(value("--delta", "0.05"));
  const { jurors, label, note } = await resolveJury();
  const consensus = await runJury(jurors, residual.map((r) => r.input));

  console.log("\nPacioli — SELECTIVE-RISK CERTIFICATE on the residual judge (distribution-free, conformal route)");
  console.log(
    "\n  cite: Akter, Shihab & Sharma, \"Selective Risk Certification for LLM Outputs via Information-Lift\n" +
      "        Statistics\" (arXiv:2509.12527, 2025). Their route is a sub-gamma PAC-Bayes information-lift\n" +
      "        bound; we take the distribution-free EXACT-BINOMIAL (Clopper–Pearson) route because at N in the\n" +
      "        tens a PAC-Bayes constant printed as a headline would be vacuous.",
  );
  console.log(`\n  jury : ${label} — ${note}`);
  console.log(`         effectiveJurors=${consensus.effectiveJurors.toFixed(2)} of ${consensus.m} (correlation-corrected, ρ̄=${consensus.meanPairwiseCorrelation.toFixed(3)})`);

  // The residual judge COMMITS a CLAIM_MISMATCH flag on its high-consensus region and ABSTAINS elsewhere.
  // Selective risk = its error (false-discovery) rate on the claims it commits a flag on.
  const goldCM = (r: GroundTruthSample): boolean => (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");
  const items: SelectiveItem[] = consensus.rows.map((row, i) => ({
    predicted: true, // a committed flag asserts CLAIM_MISMATCH
    gold: goldCM(residual[i]),
    accepted: isHighConsensusMismatch(row, consensus, DEFAULT_CONSENSUS_GATE),
  }));
  const cert = certifySelectiveRisk(items, delta);

  console.log("\n  the residual judge COMMITS a CLAIM_MISMATCH flag on its high-consensus region and ABSTAINS otherwise.");
  console.log("  selective risk = its error (false-discovery) rate on the claims it commits a flag on:");
  console.log(`\n    accepted (committed flags) : ${cert.nAccepted} of ${cert.nTotal} residual claims  (selective coverage ${pct(cert.coverage)})`);
  console.log(`    observed errors            : ${cert.errors}  (empirical selective risk ${pct(cert.empiricalRisk)})`);
  console.log(`    certified upper bound      : ${pct(cert.upperBound)} at ${pct(1 - cert.delta)} confidence  [Clopper–Pearson exact binomial]`);
  console.log(`    cross-check (Hoeffding)    : ${pct(cert.hoeffdingUpper)}`);
  console.log(`    certificate WIDTH          : ${(cert.width * 100).toFixed(1)} points above the point estimate`);

  console.log(`\n  CONVERGENCE — the certificate WIDTH shrinks as the gold set grows (holding empirical risk at ${pct(cert.empiricalRisk)}):`);
  console.log("     N        certified upper bound     width");
  for (const w of widthVsN(cert.empiricalRisk, undefined, delta)) {
    console.log(`   ${String(w.n).padStart(5)}      ${pct(w.upperBound).padEnd(22)}    ${(w.width * 100).toFixed(1)}`);
  }

  // A corollary tie-in to distillation: the distilled deterministic floor's committed verdicts are
  // themselves certifiable (0 observed errors, but an honestly-wide small-N bound).
  const distilled = distillRules(residual, consensus, all.length);
  if (distilled.promoted.length > 0) {
    const floorItems: SelectiveItem[] = residual.map((r) => {
      const fires = applyPromotedRules(r.input, distilled.promoted).length > 0;
      return { predicted: true, gold: goldCM(r), accepted: fires };
    });
    const floorCert = certifySelectiveRisk(floorItems, delta);
    console.log(
      `\n  corollary — the DISTILLED floor's committed verdicts: ${floorCert.errors} error(s) on ${floorCert.nAccepted} committed row(s) ` +
        `→ certified selective risk ≤ ${pct(floorCert.upperBound)} OOS (honestly wide at small N).`,
    );
  }

  console.log(
    "\n  HONEST READ: distribution-free, CONDITIONAL on exchangeability — NOT a tight number at N in the tens.\n" +
      `  At N=${cert.nAccepted} the ${pct(1 - cert.delta)} upper bound (${pct(cert.upperBound)}) sits far above the ${pct(cert.empiricalRisk)} we observed: an honest\n` +
      "  small-N certificate is WIDE, and we never headline it as the judge's accuracy. The METHODOLOGY and the\n" +
      "  O(1/√N) width curve are the deliverable; the keyless mock jury is a sizing instrument — swap in a real\n" +
      "  keyed jury with --judge for a measurement of an actual model.",
  );
}

async function main(): Promise<void> {
  if (flag("--saturation")) return runSaturation();
  if (flag("--conformal")) return runConformal();
  if (flag("--distill")) return runDistill();
  if (flag("--certify")) return runCertify();
  // default + explicit --equivalence
  await runEquivalence();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
