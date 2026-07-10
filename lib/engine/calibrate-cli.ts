/**
 * Pacioli — judge calibration CLI. `npm run calibrate` (HUMAN-GATED: needs ANTHROPIC_API_KEY).
 *
 * An LLM judge is a measurement instrument; you do not trust it until you have measured it
 * against the human labels. The deterministic engine (packages/engine/src/diff.ts) resolves OVERSPEND /
 * UNAUTH_RECURRENCE / SCOPE_CREEP and ABSTAINS on the fuzzy CLAIM_MISMATCH residual by design —
 * that residual is the judge's whole job. So this harness runs the gated Anthropic judge over
 * exactly the rows the engine abstains on (diff() returns no findings), labels each
 *   gold   = the human label says this row IS a CLAIM_MISMATCH
 *   judged = the Anthropic judge flags a CLAIM_MISMATCH
 * and reports Cohen's κ (chance-corrected agreement — "the judge agrees 86%" is not enough),
 * plus TPR/FPR/precision/F1/accuracy and Wilson 95% CIs, all via lib/engine/judge-eval.ts.
 *
 * HONESTY BAR: below ~30 labeled rows a κ is not
 * trustworthy. We still print it, but flag it UNRELIABLE and lead with raw agreement. A confirmed
 * "n is too small" is a valid result — never fabricate a clean κ from a thin residual.
 *
 * ADDITIVE: this file only reads the engine + dataset + judge-eval; it changes no existing logic.
 */

import { loadSeed, loadIncidents } from "./dataset";
import { diff } from "@pacioli-app/engine";
import { judge, judgeEnabled, JUDGE_MODEL } from "./judge";
import { calibrate, rateWithCI, wilsonInterval } from "./judge-eval";
import type { GroundTruthSample } from "@pacioli-app/engine";

/** Below this, a κ is not statistically meaningful — report raw agreement only. */
const MIN_N_FOR_KAPPA = 30;

const goldIsClaimMismatch = (r: GroundTruthSample): boolean =>
  (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH");

/** The judge's operating domain: rows the deterministic engine abstains on (produces no findings). */
const isEngineResidual = (r: GroundTruthSample): boolean => diff(r.input).findings.length === 0;

const fmt = (x: number | null, d = 3): string => (x == null ? "  n/a" : x.toFixed(d));
const pct = (x: number | null): string => (x == null ? "n/a" : `${Math.round(x * 100)}%`);

async function main(): Promise<void> {
  if (!judgeEnabled()) {
    // Not a failure: the judge is gated, so this harness is human-gated by design. Exit 0 so a
    // reviewer skimming exit codes reads it as a deliberate skip, not a broken script.
    console.log(
      "calibrate: SKIPPED — no ANTHROPIC_API_KEY. The CLAIM_MISMATCH judge is gated, so this calibration harness is human-gated by design (expected, not a failure).",
    );
    return;
  }

  const corpus = [...loadSeed(), ...loadIncidents()];
  const residual = corpus.filter(isEngineResidual);
  if (residual.length === 0) {
    console.log(
      "No residual rows (the deterministic engine resolved everything). Add CLAIM_MISMATCH rows the engine abstains on to calibrate the judge.",
    );
    return;
  }

  console.log(
    `\nPacioli judge calibration — model ${JUDGE_MODEL} (live Anthropic).` +
      `\nRunning the judge over ${residual.length} residual rows (the deterministic engine abstained on these);` +
      `\ngold = human label is CLAIM_MISMATCH, judged = judge flags CLAIM_MISMATCH.\n`,
  );

  const samples: Array<{ gold: boolean; judged: boolean }> = [];
  let errored = 0;
  for (const r of residual) {
    const gold = goldIsClaimMismatch(r);
    try {
      const findings = await judge(r.input);
      const judged = findings.some((f) => f.type === "CLAIM_MISMATCH");
      samples.push({ gold, judged });
      const hit = gold === judged ? "✓" : "✗";
      const tag = findings.find((f) => f.type === "CLAIM_MISMATCH");
      const detail = tag ? `${tag.dimension}/${tag.severity}` : "—";
      console.log(
        `  ${r.id.padEnd(10)} gold=${(gold ? "CM" : "ok").padEnd(2)} judged=${(judged ? "CM" : "ok").padEnd(2)} ${hit}  (${detail})`,
      );
    } catch (e) {
      // One API failure must not poison the whole run; exclude this row and count it honestly.
      errored++;
      console.log(`  ${r.id.padEnd(10)} gold=${gold ? "CM" : "ok"}  ERROR — excluded (${(e as Error).message.slice(0, 60)})`);
    }
  }

  const report = calibrate(samples);
  const { confusion: c, n } = report;
  const positives = c.tp + c.fn; // gold-CM rows
  const negatives = c.fp + c.tn; // non-CLAIM_MISMATCH rows (balanced + engine-missed other-class)
  const agree = c.tp + c.tn;

  console.log(`\n  Scored n = ${n}${errored ? ` (${errored} row(s) excluded on API error)` : ""}`);
  console.log(`  confusion: tp=${c.tp} fp=${c.fp} tn=${c.tn} fn=${c.fn}`);
  console.log(`  class balance: ${positives} gold-CM (positive) · ${negatives} non-CM (negative)`);

  if (n < MIN_N_FOR_KAPPA) {
    console.log(
      `\n  n=${n} labeled rows — too few for a meaningful Cohen's κ (need ≥ ${MIN_N_FOR_KAPPA}). Reporting raw agreement only; build out the residual gold set before trusting any κ.`,
    );
  }

  const tooSmall = n < MIN_N_FOR_KAPPA ? " [UNRELIABLE: n too small]" : "";
  console.log(`\n  raw agreement: ${agree}/${n} (${pct(n ? agree / n : null)})  — the chance-inflated number`);
  console.log(
    `  Cohen's κ (judge vs human): ${fmt(report.cohensKappa)}${tooSmall}   (benchmark against a human-to-human κ before trusting)`,
  );
  console.log(`  accuracy: ${fmt(report.accuracy, 2)} on ${n} rows`);
  console.log(
    `  TPR / recall (judge catches a real CLAIM_MISMATCH): ${fmt(report.tpr, 2)}  CI ${rateWithCI(c.tp, positives)}  (over ${positives} positives)`,
  );
  console.log(
    `  FPR (judge over-calls on a non-CM row): ${fmt(report.fpr, 2)}  CI ${rateWithCI(c.fp, negatives)}  (over ${negatives} negatives)`,
  );
  console.log(`  precision: ${fmt(report.precision, 2)}   F1: ${fmt(report.f1, 2)}`);

  // Honest read of the thin classes: a 95% CI that spans most of [0,1] means "essentially unmeasured".
  const tprCI = positives ? wilsonInterval(c.tp, positives) : null;
  const fprCI = negatives ? wilsonInterval(c.fp, negatives) : null;
  const wide = (ci: { low: number; high: number } | null): boolean => !ci || ci.high - ci.low > 0.4;
  if (wide(tprCI) || wide(fprCI)) {
    console.log(
      `\n  NOTE: ${negatives < 10 ? `only ${negatives} negative row(s) — FPR is essentially unmeasured; ` : ""}` +
        `${positives < 10 ? `only ${positives} positive row(s); ` : ""}` +
        `the Wilson CIs are wide. Treat per-class rates as directional, not headline.`,
    );
  }

  console.log(
    `\n  reminder: ship the judge behind the deterministic floor (it never re-flags overspend/recurrence/scope) and` +
      `\n  treat any CLAIM_MISMATCH as assistive + badged until κ clears a human-to-human baseline on a larger residual set.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
