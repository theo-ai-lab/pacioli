import { describe, it, expect } from "vitest";
import { calibrate, wilsonInterval, rateWithCI, positionalBiasRate } from "./judge-eval";

describe("judge calibration", () => {
  it("computes the confusion matrix and rates from a known set", () => {
    // 7 TP, 1 FP, 8 TN, 2 FN  (n=18)
    const samples = [
      ...Array(7).fill({ gold: true, judged: true }),
      ...Array(1).fill({ gold: false, judged: true }),
      ...Array(8).fill({ gold: false, judged: false }),
      ...Array(2).fill({ gold: true, judged: false }),
    ];
    const r = calibrate(samples);
    expect(r.confusion).toEqual({ tp: 7, fp: 1, tn: 8, fn: 2 });
    expect(r.precision).toBeCloseTo(7 / 8, 6);
    expect(r.tpr).toBeCloseTo(7 / 9, 6);
    expect(r.fpr).toBeCloseTo(1 / 9, 6);
    expect(r.accuracy).toBeCloseTo(15 / 18, 6);
    expect(r.cohensKappa).toBeGreaterThan(0.6);
    expect(r.cohensKappa).toBeLessThanOrEqual(1);
  });

  it("kappa is 1.0 for a perfect judge and ~0 for a chance judge", () => {
    const perfect = calibrate([
      ...Array(5).fill({ gold: true, judged: true }),
      ...Array(5).fill({ gold: false, judged: false }),
    ]);
    expect(perfect.cohensKappa).toBeCloseTo(1, 6);

    // judge that always says "true": kappa should be ~0 (no chance-corrected agreement)
    const constant = calibrate([
      ...Array(5).fill({ gold: true, judged: true }),
      ...Array(5).fill({ gold: false, judged: true }),
    ]);
    expect(Math.abs(constant.cohensKappa)).toBeLessThan(1e-9);
  });
});

describe("Wilson confidence interval", () => {
  it("brackets the point estimate and tightens with n", () => {
    const small = wilsonInterval(5, 10);
    expect(small.low).toBeGreaterThan(0.2);
    expect(small.high).toBeLessThan(0.8);
    const big = wilsonInterval(500, 1000);
    expect(big.high - big.low).toBeLessThan(small.high - small.low); // tighter with more data
  });

  it("formats a rate as an interval string", () => {
    expect(rateWithCI(0, 0)).toBe("—");
    expect(rateWithCI(40, 100)).toMatch(/^\d+–\d+%$/);
  });
});

describe("positional-bias probe (evaluator-of-the-evaluator)", () => {
  type Case = { a: number; b: number };
  const swap = (c: Case): Case => ({ a: c.b, b: c.a });
  const cases: Case[] = [
    { a: 1, b: 2 },
    { a: 5, b: 3 },
    { a: 9, b: 9 },
  ];

  it("flags a judge whose verdict depends on order", async () => {
    const biased = async (c: Case) => c.a > c.b; // flips under swap whenever a≠b
    expect(await positionalBiasRate(cases, biased, swap)).toBeGreaterThan(0.5);
  });

  it("clears an order-invariant judge", async () => {
    const fair = async (c: Case) => c.a + c.b > 5; // symmetric → never flips
    expect(await positionalBiasRate(cases, fair, swap)).toBe(0);
  });
});
