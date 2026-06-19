import { describe, it, expect } from "vitest";
import {
  AMBIGUITY_EPS,
  majorityFlagProbability,
  rowMatchProbability,
  saturationCurve,
  syntheticJudgeInstrument,
  type JudgeRow,
} from "./saturation";

// ── the binomial majority-vote primitive ─────────────────────────────────────────────────────────────

describe("majorityFlagProbability — exact odd-k binomial majority", () => {
  it("rejects even and non-positive k (a tie has no majority)", () => {
    expect(() => majorityFlagProbability(0.7, 2)).toThrow(RangeError);
    expect(() => majorityFlagProbability(0.7, 0)).toThrow(RangeError);
    expect(() => majorityFlagProbability(0.7, -3)).toThrow(RangeError);
    expect(() => majorityFlagProbability(0.7, 3.5)).toThrow(RangeError);
  });

  it("is exactly 1/2 at the coin flip for every odd k (symmetry)", () => {
    for (const k of [1, 3, 5, 7, 21, 51]) expect(majorityFlagProbability(0.5, k)).toBeCloseTo(0.5, 10);
  });

  it("k=1 is just p; degenerate p in {0,1} are absorbing", () => {
    expect(majorityFlagProbability(0.73, 1)).toBeCloseTo(0.73, 12);
    expect(majorityFlagProbability(0, 9)).toBe(0);
    expect(majorityFlagProbability(1, 9)).toBe(1);
  });

  it("matches a hand-computed 3-of-3 majority: P = p^3 + 3p^2(1-p)", () => {
    const p = 0.6;
    const expected = p ** 3 + 3 * p ** 2 * (1 - p);
    expect(majorityFlagProbability(p, 3)).toBeCloseTo(expected, 12);
  });

  it("Condorcet: for p>1/2 majority-vote is strictly increasing in odd k and converges UP to 1", () => {
    const ks = [1, 3, 5, 7, 9, 15, 31, 101];
    const vals = ks.map((k) => majorityFlagProbability(0.62, k));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    expect(vals[vals.length - 1]).toBeGreaterThan(0.99);
  });

  it("Condorcet (mirror): for p<1/2 it is strictly decreasing in odd k and converges DOWN to 0", () => {
    const ks = [1, 3, 5, 7, 9, 15, 31, 101];
    const vals = ks.map((k) => majorityFlagProbability(0.38, k));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1]);
    expect(vals[vals.length - 1]).toBeLessThan(0.01);
  });

  it("stays a probability in [0,1] across the parameter grid (no overflow from the iterative pmf)", () => {
    for (const p of [0.01, 0.2, 0.49, 0.51, 0.8, 0.99]) {
      for (const k of [1, 11, 51, 101]) {
        const v = majorityFlagProbability(p, k);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("rowMatchProbability — orient the majority vote against the gold label", () => {
  it("a gold-CM row matches with P(flag); a gold-ok row matches with 1−P(flag)", () => {
    const cm: JudgeRow = { flagProb: 0.7, goldFlag: true };
    const ok: JudgeRow = { flagProb: 0.7, goldFlag: false };
    expect(rowMatchProbability(cm, 3)).toBeCloseTo(majorityFlagProbability(0.7, 3), 12);
    expect(rowMatchProbability(ok, 3)).toBeCloseTo(1 - majorityFlagProbability(0.7, 3), 12);
  });
});

// ── the sample-k saturation curve on a FIXED gold set ─────────────────────────────────────────────────

describe("saturationCurve — sample-k axis only, fixed n", () => {
  const goldFlags = [true, true, false, true, false, true, false, false, true, false];

  it("accuracy is monotone non-decreasing in k and never exceeds the asymptote (well-separated judge)", () => {
    // every row leans the right way by a fixed margin → consensus is perfect, curve climbs to 1.0
    const rows: JudgeRow[] = goldFlags.map((goldFlag) => ({ flagProb: goldFlag ? 0.75 : 0.25, goldFlag }));
    const curve = saturationCurve(rows);
    expect(curve.n).toBe(rows.length);
    for (let i = 1; i < curve.points.length; i++) {
      expect(curve.points[i].accuracy).toBeGreaterThanOrEqual(curve.points[i - 1].accuracy - 1e-12);
      expect(curve.points[i].accuracy).toBeLessThanOrEqual(curve.asymptote + 1e-9);
    }
    expect(curve.asymptote).toBeCloseTo(1, 10);
    expect(curve.irreducibleAmbiguity).toBe(0);
    expect(curve.saturationK).not.toBeNull();
  });

  it("coin-flip rows are an irreducible floor: they contribute exactly 1/2 to the asymptote, forever", () => {
    // all rows are coin flips → no amount of sampling resolves any of them
    const rows: JudgeRow[] = goldFlags.map((goldFlag) => ({ flagProb: 0.5, goldFlag }));
    const curve = saturationCurve(rows);
    expect(curve.irreducibleAmbiguity).toBe(1);
    expect(curve.asymptote).toBeCloseTo(0.5, 10);
    // accuracy is pinned at 1/2 for every k — sampling buys nothing
    for (const p of curve.points) expect(p.accuracy).toBeCloseTo(0.5, 10);
  });

  it("the gain column reports the per-step improvement and the first point's gain is 0", () => {
    const rows: JudgeRow[] = goldFlags.map((goldFlag) => ({ flagProb: goldFlag ? 0.7 : 0.3, goldFlag }));
    const curve = saturationCurve(rows, [1, 3, 5]);
    expect(curve.points[0].gain).toBe(0);
    expect(curve.points[1].gain).toBeCloseTo(curve.points[1].accuracy - curve.points[0].accuracy, 12);
    expect(curve.points[2].gain).toBeCloseTo(curve.points[2].accuracy - curve.points[1].accuracy, 12);
  });

  it("a partly-ambiguous set saturates BELOW 1, at (1 − coin-flip mass · 1/2)", () => {
    // half coin flips, half well-separated → asymptote = 0.5·(1) + 0.5·(0.5) = 0.75
    const rows: JudgeRow[] = [
      { flagProb: 0.5, goldFlag: true },
      { flagProb: 0.8, goldFlag: true },
      { flagProb: 0.5, goldFlag: false },
      { flagProb: 0.2, goldFlag: false },
    ];
    const curve = saturationCurve(rows);
    expect(curve.irreducibleAmbiguity).toBeCloseTo(0.5, 10);
    expect(curve.asymptote).toBeCloseTo(0.75, 10);
  });

  it("the empty set is well-defined (no NaN)", () => {
    const curve = saturationCurve([]);
    expect(curve.n).toBe(0);
    expect(curve.asymptote).toBe(0);
    expect(curve.irreducibleAmbiguity).toBe(0);
  });
});

describe("syntheticJudgeInstrument — a DOCUMENTED keyless sizing model, not a measurement", () => {
  it("plants the requested coin-flip fraction and leans the rest the right way", () => {
    const goldFlags = [true, false, true, false, true, false, true, false, true, false];
    const rows = syntheticJudgeInstrument(goldFlags, { margin: 0.2, ambiguousFraction: 0.2 });
    expect(rows).toHaveLength(goldFlags.length);
    const coinFlips = rows.filter((r) => Math.abs(r.flagProb - 0.5) < AMBIGUITY_EPS);
    expect(coinFlips.length).toBeGreaterThan(0);
    // non-ambiguous rows lean toward their gold label
    for (const r of rows) {
      if (Math.abs(r.flagProb - 0.5) < AMBIGUITY_EPS) continue;
      expect(r.flagProb > 0.5).toBe(r.goldFlag);
    }
  });

  it("ambiguousFraction = 0 plants no coin flips (every row leans)", () => {
    const rows = syntheticJudgeInstrument([true, false, true, false], { ambiguousFraction: 0 });
    expect(rows.every((r) => Math.abs(r.flagProb - 0.5) >= AMBIGUITY_EPS)).toBe(true);
  });
});
