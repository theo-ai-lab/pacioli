import { describe, it, expect } from "vitest";
import {
  binomialCdfAtMost,
  clopperPearsonUpper,
  hoeffdingUpper,
  certifySelectiveRisk,
  widthVsN,
  type SelectiveItem,
} from "./selective-risk";

// ── the exact binomial machinery ──────────────────────────────────────────────────────────────────────────

describe("binomialCdfAtMost — exact lower-tail binomial CDF", () => {
  it("matches a hand-computed value: P(X≤1) for Binom(3, 1/2) = 4/8", () => {
    expect(binomialCdfAtMost(1, 3, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("degenerate edges are exact (p=0 ⇒ X=0; p=1 ⇒ X=n; e≥n ⇒ 1)", () => {
    expect(binomialCdfAtMost(0, 5, 0)).toBe(1);
    expect(binomialCdfAtMost(4, 5, 1)).toBe(0);
    expect(binomialCdfAtMost(5, 5, 1)).toBe(1);
    expect(binomialCdfAtMost(7, 5, 0.3)).toBe(1); // e ≥ n
  });

  it("is monotone DECREASING in p for a fixed (e, n)", () => {
    const ps = [0.05, 0.2, 0.4, 0.6, 0.8, 0.95];
    const vals = ps.map((p) => binomialCdfAtMost(2, 10, p));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1]);
  });
});

describe("clopperPearsonUpper — exact one-sided distribution-free upper bound", () => {
  it("equals the closed form 1 − delta^(1/n) when zero errors are observed", () => {
    for (const n of [5, 7, 20, 100]) {
      expect(clopperPearsonUpper(0, n, 0.05)).toBeCloseTo(1 - Math.pow(0.05, 1 / n), 6);
    }
  });

  it("at the solved p_U the binomial tail equals delta (the defining equation)", () => {
    const n = 25;
    const e = 2;
    const pU = clopperPearsonUpper(e, n, 0.05);
    expect(binomialCdfAtMost(e, n, pU)).toBeCloseTo(0.05, 4);
  });

  it("is ≥ the empirical rate, ≤ 1, and tightens (decreases) as n grows for a fixed error fraction", () => {
    const uppers = [10, 50, 250, 1000].map((n) => clopperPearsonUpper(Math.round(0.1 * n), n, 0.05));
    for (const u of uppers) {
      expect(u).toBeGreaterThanOrEqual(0.1);
      expect(u).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < uppers.length; i++) expect(uppers[i]).toBeLessThan(uppers[i - 1]);
  });

  it("e ≥ n and n ≤ 0 admit the worst case (upper bound 1) — no false confidence with no evidence", () => {
    expect(clopperPearsonUpper(7, 7, 0.05)).toBe(1);
    expect(clopperPearsonUpper(0, 0, 0.05)).toBe(1);
  });
});

describe("hoeffdingUpper — distribution-free cross-check", () => {
  it("is r̂ + √(ln(1/δ)/2n), capped at 1", () => {
    expect(hoeffdingUpper(0.1, 100, 0.05)).toBeCloseTo(0.1 + Math.sqrt(Math.log(20) / 200), 12);
    expect(hoeffdingUpper(0.9, 3, 0.05)).toBe(1); // capped
  });
});

// ── the certificate ───────────────────────────────────────────────────────────────────────────────────────

describe("certifySelectiveRisk — selective risk on the accepted region, certified", () => {
  const items = (acc: Array<[boolean, boolean]>, rest = 0): SelectiveItem[] => [
    ...acc.map(([predicted, gold]) => ({ predicted, gold, accepted: true })),
    ...Array.from({ length: rest }, () => ({ predicted: false, gold: true, accepted: false })),
  ];

  it("counts errors only on the accepted region and reports coverage over the whole set", () => {
    // 9 correct + 1 wrong accepted; 19 abstained → coverage 10/29
    const acc: Array<[boolean, boolean]> = [
      ...Array.from({ length: 9 }, () => [true, true] as [boolean, boolean]),
      [true, false],
    ];
    const cert = certifySelectiveRisk(items(acc, 19), 0.05);
    expect(cert.nTotal).toBe(29);
    expect(cert.nAccepted).toBe(10);
    expect(cert.coverage).toBeCloseTo(10 / 29, 10);
    expect(cert.errors).toBe(1);
    expect(cert.empiricalRisk).toBeCloseTo(0.1, 10);
    expect(cert.upperBound).toBeCloseTo(clopperPearsonUpper(1, 10, 0.05), 10);
    expect(cert.width).toBeCloseTo(cert.upperBound - cert.empiricalRisk, 10);
  });

  it("0 observed errors still yields an HONESTLY WIDE small-N bound (not a vacuous 0)", () => {
    const acc: Array<[boolean, boolean]> = Array.from({ length: 7 }, () => [true, true]);
    const cert = certifySelectiveRisk(items(acc), 0.05);
    expect(cert.empiricalRisk).toBe(0);
    expect(cert.upperBound).toBeCloseTo(1 - Math.pow(0.05, 1 / 7), 6); // ≈ 0.348, NOT 0
    expect(cert.upperBound).toBeGreaterThan(0.3);
  });

  it("the Hoeffding cross-check is never below the empirical risk", () => {
    const acc: Array<[boolean, boolean]> = [...Array.from({ length: 8 }, () => [true, true] as [boolean, boolean]), [true, false], [true, false]];
    const cert = certifySelectiveRisk(items(acc), 0.05);
    expect(cert.hoeffdingUpper).toBeGreaterThanOrEqual(cert.empiricalRisk);
  });

  it("an empty accepted region is the trivial certificate (upper bound 1, no false confidence)", () => {
    const cert = certifySelectiveRisk(items([], 12), 0.05);
    expect(cert.nAccepted).toBe(0);
    expect(cert.coverage).toBe(0);
    expect(cert.upperBound).toBe(1);
  });

  it("a fully-empty input is well-defined (no NaN)", () => {
    const cert = certifySelectiveRisk([], 0.05);
    expect(cert.nTotal).toBe(0);
    expect(cert.empiricalRisk).toBe(0);
    expect(cert.upperBound).toBe(1);
  });
});

// ── convergence: width shrinks as the gold set grows ──────────────────────────────────────────────────────

describe("widthVsN — the certificate WIDTH shrinks monotonically as N grows", () => {
  it("upper bound and width both strictly decrease across the N grid (fixed empirical risk)", () => {
    const pts = widthVsN(0.1, [10, 25, 50, 100, 250, 1000], 0.05);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].upperBound).toBeLessThan(pts[i - 1].upperBound);
      expect(pts[i].width).toBeLessThan(pts[i - 1].width);
    }
    expect(pts[pts.length - 1].width).toBeLessThan(0.05); // wide at N=10, tight by N=1000
  });

  it("at r̂=0 the width is the closed-form 1 − delta^(1/N), shrinking toward 0", () => {
    const pts = widthVsN(0, [10, 100, 1000], 0.05);
    for (const p of pts) {
      expect(p.errors).toBe(0);
      expect(p.width).toBeCloseTo(1 - Math.pow(0.05, 1 / p.n), 6);
    }
    expect(pts[0].width).toBeGreaterThan(pts[2].width);
  });
});
