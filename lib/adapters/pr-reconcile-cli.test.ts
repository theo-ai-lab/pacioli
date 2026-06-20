import { describe, it, expect } from "vitest";
import { DEMO_PR, formatReport, parseArgs } from "./pr-reconcile-cli";
import { reconcilePullRequest } from "./pr-reconcile";

describe("pr-reconcile-cli — argument parsing", () => {
  it("parses flags, the policy value, and a positional file", () => {
    const o = parseArgs(["pr.json", "--policy", "stable-k", "--k", "3", "--json", "--gate"]);
    expect(o).toEqual({ file: "pr.json", policy: "stable-k", k: 3, json: true, gate: true });
  });

  it("defaults to the safe policy with no flags", () => {
    const o = parseArgs([]);
    expect(o).toMatchObject({ policy: "safe", json: false, gate: false });
    expect(o.file).toBeUndefined();
  });

  it("does not mistake a flag value for the positional file", () => {
    const o = parseArgs(["--policy", "safe"]);
    expect(o.file).toBeUndefined();
  });
});

describe("pr-reconcile-cli — the labelled demo + human report", () => {
  it("the DEMO PR is clearly labelled and reconciles to a flagged OVERSPEND committed early", () => {
    expect(DEMO_PR.claim.title).toMatch(/\[DEMO\]/);
    const run = reconcilePullRequest(DEMO_PR.claim, DEMO_PR.evidence);
    expect(run.finalClass).toBe("flagged");
    expect(run.finalVerdict.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(run.committedEarly).toBe(true);
    expect(run.commitAt).toBe(1); // flagged at the diff-size signal, before CI
  });

  it("renders a human trace with the signals, the early-commit reason, findings, and the receipt", () => {
    const run = reconcilePullRequest(DEMO_PR.claim, DEMO_PR.evidence);
    const out = formatReport(run, DEMO_PR.claim, { policy: "safe", receiptId: "sha256:deadbeefdeadbeef" });
    expect(out).toContain("incremental PR reconciliation");
    expect(out).toContain("signal 1  diff size");
    expect(out).toContain("OUT OF BALANCE");
    expect(out).toContain("information-complete");
    expect(out).toContain("OVERSPEND");
    expect(out).toContain("CLAIM_MISMATCH"); // the demo claims tests pass while CI failed
    expect(out).toContain("Receipt: sha256:deadbeefdeadbeef");
  });
});
