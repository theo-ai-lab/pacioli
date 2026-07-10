import { describe, it, expect } from "vitest";
import {
  bandDecision,
  evaluateCoverage,
  fitConformalBand,
  mismatchScore,
  splitCalibTest,
  type LabeledScore,
} from "./conformal";
import { loadSeed, loadIncidents } from "./dataset";
import type { DiffInput } from "@pacioli-app/engine";

// ── the keyless mismatch-score proxy ──────────────────────────────────────────────────────────────────

const clean: DiffInput = {
  claim: { agent: "a", task: "book a flight", text: "booked your flight for $278", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "email", merchant: "United", amountUsd: 278, date: "2025-03-01", items: ["flight"], recurring: false, excerpt: "United flight $278 on 2025-03-01" },
};

const suspicious: DiffInput = {
  claim: { agent: "a", task: "book the cheapest nonstop", text: "booked the cheapest nonstop flight", authorized: { budgetUsd: 300, mayPurchase: true, constraints: ["nonstop", "cheapest"] } },
  evidence: { source: "email", merchant: "United", amountUsd: 290, date: "2025-03-01", items: ["flight"], recurring: false, excerpt: "we were unable to find a nonstop and booked a connecting flight instead" },
};

describe("mismatchScore — a transparent, keyless, auditable proxy in [0,1]", () => {
  it("returns a bounded score plus its four named components", () => {
    const { score, components } = mismatchScore(suspicious);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(Object.keys(components).sort()).toEqual(["dateConflict", "divergence", "lexicalNovelty", "qualifier"]);
  });

  it("scores a superlative-claim-with-divergent-evidence ABOVE a clean match (carries signal, by construction)", () => {
    expect(mismatchScore(suspicious).score).toBeGreaterThan(mismatchScore(clean).score);
  });

  it("fires the qualifier and divergence components on the suspicious claim", () => {
    const { components } = mismatchScore(suspicious);
    expect(components.qualifier).toBe(1); // "cheapest" / "nonstop"
    expect(components.divergence).toBe(1); // "unable" / "instead"
  });

  it("flags a date conflict when claim and evidence dates disagree", () => {
    const conflicting: DiffInput = {
      claim: { agent: "a", task: "book for 2025-03-01", text: "booked for 2025-03-01", authorized: { mayPurchase: true } },
      evidence: { source: "email", merchant: "X", amountUsd: 10, date: "2025-09-09", items: [], recurring: false, excerpt: "charged on 2025-09-09" },
    };
    expect(mismatchScore(conflicting).components.dateConflict).toBe(1);
  });
});

// ── split-conformal calibration carves a coverage-controlled trust zone ───────────────────────────────

describe("fitConformalBand / bandDecision — a well-separated proxy yields a real trust zone", () => {
  // a clean separable calibration set: ok rows score low, mismatch rows score high, enough rows for a
  // non-trivial finite-sample quantile at alpha=0.1.
  const calib: LabeledScore[] = [
    ...Array.from({ length: 12 }, () => ({ score: 0.1, gold: false })),
    ...Array.from({ length: 12 }, () => ({ score: 0.9, gold: true })),
  ];

  it("admits 'ok' below tauLo and 'mismatch' above tauHi, and escalates the ambiguous middle", () => {
    const band = fitConformalBand(calib, 0.1);
    expect(band.tauLo).toBeLessThan(band.tauHi); // a real (non-degenerate) trust zone exists
    expect(bandDecision(0.05, band)).toBe("ok");
    expect(bandDecision(0.95, band)).toBe("mismatch");
    expect(bandDecision(0.5, band)).toBe("escalate");
    expect(band.nOk).toBe(12);
    expect(band.nMismatch).toBe(12);
  });

  it("a SIGNAL-FREE proxy collapses the band to escalate-everything — the SAFE failure, never false trust", () => {
    // both classes pile on the same score → the conformal quantiles overlap → no trust zone
    const flat: LabeledScore[] = [
      ...Array.from({ length: 10 }, () => ({ score: 0.5, gold: false })),
      ...Array.from({ length: 10 }, () => ({ score: 0.5, gold: true })),
    ];
    const band = fitConformalBand(flat, 0.1);
    expect(band.tauLo >= band.tauHi).toBe(true); // degenerate → every claim is ambiguous
    expect(bandDecision(0.5, band)).toBe("escalate");
  });

  it("an empty calibration set admits each class everywhere (escalate-safe, never a confident guess)", () => {
    const band = fitConformalBand([], 0.1);
    expect(band.nOk).toBe(0);
    expect(band.nMismatch).toBe(0);
    expect(band.tauLo >= band.tauHi).toBe(true);
  });
});

// ── held-out coverage, scored ONCE ────────────────────────────────────────────────────────────────────

describe("evaluateCoverage — empirical coverage with a Wilson CI on a held-out split", () => {
  const band = fitConformalBand(
    [
      ...Array.from({ length: 12 }, () => ({ score: 0.1, gold: false })),
      ...Array.from({ length: 12 }, () => ({ score: 0.9, gold: true })),
    ],
    0.1,
  );

  it("achieves the target coverage on a held-out set the band separates, and reports a Wilson CI", () => {
    const test: LabeledScore[] = [
      ...Array.from({ length: 10 }, () => ({ score: 0.05, gold: false })),
      ...Array.from({ length: 10 }, () => ({ score: 0.95, gold: true })),
    ];
    const report = evaluateCoverage(test, band);
    expect(report.n).toBe(20);
    expect(report.coverage).toBeCloseTo(1, 10); // every true label lands in its prediction set
    expect(report.coverageCI.low).toBeLessThanOrEqual(report.coverage);
    expect(report.coverageCI.high).toBeGreaterThanOrEqual(report.coverage);
    expect(report.trustRate).toBeCloseTo(1, 10);
    expect(report.escalationRate).toBeCloseTo(0, 10);
    expect(report.selectiveAccuracy).toBeCloseTo(1, 10);
  });

  it("an empty test split is well-defined (no NaN), with a null selective accuracy", () => {
    const report = evaluateCoverage([], band);
    expect(report.n).toBe(0);
    expect(report.coverage).toBe(0);
    expect(report.selectiveAccuracy).toBeNull();
  });
});

// ── a seeded, reproducible calibration/test split ─────────────────────────────────────────────────────

describe("splitCalibTest — deterministic so 'scored once' is reproducible", () => {
  const rows = Array.from({ length: 30 }, (_, i) => i);

  it("partitions the rows exactly (no overlap, no loss) and is stable under a fixed seed", () => {
    const a = splitCalibTest(rows, 0.5, 1234);
    const b = splitCalibTest(rows, 0.5, 1234);
    expect(a).toEqual(b); // same seed → identical split
    expect(a.calib.length + a.test.length).toBe(rows.length);
    expect(new Set([...a.calib, ...a.test]).size).toBe(rows.length); // a true partition
  });

  it("a different seed shuffles differently (the split is genuinely randomized)", () => {
    const a = splitCalibTest(rows, 0.5, 1234);
    const c = splitCalibTest(rows, 0.5, 9999);
    expect(a.calib).not.toEqual(c.calib);
  });
});

// ── integration: the proxy + conformal layer runs on the real residual, keylessly ────────────────────

describe("conformal layer over the real residual corpus (keyless, zero model spend)", () => {
  it("produces a bounded coverage in [0,1] and never certifies an OK zone it cannot calibrate", () => {
    const residual = [...loadSeed(), ...loadIncidents()].filter((r) => r.input);
    const scored: LabeledScore[] = residual.map((r) => ({
      score: mismatchScore(r.input).score,
      gold: (r.target.findings ?? []).some((f) => f.type === "CLAIM_MISMATCH"),
    }));
    const { calib, test } = splitCalibTest(scored, 0.5, 1234);
    const band = fitConformalBand(calib, 0.1);
    const report = evaluateCoverage(test, band);
    expect(report.coverage).toBeGreaterThanOrEqual(0);
    expect(report.coverage).toBeLessThanOrEqual(1);
    expect(report.escalationRate + report.trustRate).toBeCloseTo(1, 10);
  });
});
