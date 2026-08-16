/**
 * Pacioli — the deploy-parity probe asserts on the VERDICT, and its expectation is tied to the engine.
 *
 * Two things have to hold for the probe to mean anything:
 *   1. the fixture's expected verdict is what THIS engine actually produces (otherwise the probe is
 *      asserting a guess, and would go red on a correct deploy or green on a wrong one), and
 *   2. the assertion is strict enough to catch a deployment that answers 200 but reconciles wrongly.
 */
import { describe, it, expect } from "vitest";
import { reconcileEndpoint } from "@/lib/api/reconcile-endpoint";
import { FIXTURE, EXPECTED, checkVerdict } from "./parity-probe.mjs";

describe("deploy-parity probe — asserts on data, not a status code", () => {
  it("the fixture's expected verdict is exactly what the engine produces", async () => {
    const res = await reconcileEndpoint(FIXTURE, { allowJudge: false });
    expect(res.status).toBe(200);
    // The probe's expectation is derived from the real engine, so it can never drift into asserting
    // a verdict the product no longer gives.
    expect(checkVerdict(res.body)).toEqual([]);
    expect(res.body.findings.some((f) => f.type === EXPECTED.findingType)).toBe(true);
  });

  it("catches a deployment that answers 200 but reconciles wrongly", async () => {
    const { body } = await reconcileEndpoint(FIXTURE, { allowJudge: false });

    expect(checkVerdict({ ...body, balanced: true })).toContainEqual(expect.stringContaining("balanced"));
    expect(checkVerdict({ ...body, deltaUsd: 0 })).toContainEqual(expect.stringContaining("deltaUsd"));
    expect(checkVerdict({ ...body, findings: [] })).toContainEqual(expect.stringContaining("OVERSPEND"));
    expect(checkVerdict({ ...body, receiptId: "nope" })).toContainEqual(expect.stringContaining("receiptId"));
  });

  it("fails a finding that flags without citing BOTH sides — the product's core promise", async () => {
    const { body } = await reconcileEndpoint(FIXTURE, { allowJudge: false });
    const strip = (key) => ({ ...body, findings: body.findings.map((f) => ({ ...f, [key]: "" })) });

    expect(checkVerdict(strip("claimedRef"))).toContainEqual(expect.stringContaining("claimedRef"));
    expect(checkVerdict(strip("actualRef"))).toContainEqual(expect.stringContaining("actualRef"));
  });

  it("rejects a non-object body instead of passing it", () => {
    expect(checkVerdict(null).length).toBeGreaterThan(0);
    expect(checkVerdict("<html>404</html>").length).toBeGreaterThan(0);
  });
});
