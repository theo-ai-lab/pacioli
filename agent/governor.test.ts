/**
 * Pacioli — governor gate tests (OFFLINE).
 *
 * The Plimsoll governor is invoked over a subprocess seam, which is INJECTED here as a fake so these
 * tests never spawn Python — they assert the gate's contract: it maps the CLI's JSON + exit code onto
 * an allow/deny decision, and degrades HONESTLY (outcome "unavailable") under the configured fail
 * policy when the engine can't run. The REAL round trip (actually spawning Plimsoll) lives in the
 * runnable demo, agent/governor-demo.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { createPlimsollGovernor, type Subprocess, type SubprocessResult } from "./governor";

/** A fake subprocess that returns a canned result and records how it was invoked. */
function fakeSubprocess(result: SubprocessResult): { run: Subprocess; calls: Array<{ command: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv }> = [];
  const run: Subprocess = async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin, env: opts.env });
    return result;
  };
  return { run, calls };
}

const ALLOW: SubprocessResult = {
  code: 0,
  stdout: JSON.stringify({
    allowed: true,
    decision: "allow",
    proposed_tool: "subscribe",
    summary: "allow: no governor rule blocked 'subscribe'",
    blocking_findings: [],
  }),
  stderr: "",
};

const BLOCK: SubprocessResult = {
  code: 1,
  stdout: JSON.stringify({
    allowed: false,
    decision: "block",
    proposed_tool: "subscribe",
    summary: "block: 'subscribe' blocked by max_estimated_cost_usd",
    blocking_findings: [{ rule_id: "max_estimated_cost_usd", severity: "medium", message: "Trace exceeded estimated_cost_usd budget." }],
  }),
  stderr: "",
};

describe("createPlimsollGovernor — maps the CLI contract onto a decision", () => {
  it("allows when the governor returns allowed:true (exit 0)", async () => {
    const { run, calls } = fakeSubprocess(ALLOW);
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", policyPath: "/fake/policy.json", subprocess: run });
    const d = await gov.check({ tool: "subscribe", estimated_cost_usd: 15 });
    expect(d.outcome).toBe("allow");
    expect(d.allowed).toBe(true);
    expect(d.blockingRules).toEqual([]);

    // It really invoked the deterministic CLI path with PYTHONPATH + the call on stdin.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["-m", "plimsoll.cli", "governor", "--json", "--policy", "/fake/policy.json"]);
    expect(calls[0].env.PYTHONPATH).toContain("/fake/plimsoll");
    expect(JSON.parse(calls[0].stdin)).toMatchObject({ tool: "subscribe", estimated_cost_usd: 15 });
  });

  it("blocks when the governor returns allowed:false (exit 1), surfacing the rule ids", async () => {
    const { run } = fakeSubprocess(BLOCK);
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", subprocess: run });
    const d = await gov.check({ tool: "subscribe", estimated_cost_usd: 30 });
    expect(d.outcome).toBe("block");
    expect(d.allowed).toBe(false);
    expect(d.blockingRules).toContain("max_estimated_cost_usd");
  });

  it("omits --policy when none is configured (permissive empty policy)", async () => {
    const { run, calls } = fakeSubprocess(ALLOW);
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", subprocess: run });
    await gov.check({ tool: "subscribe" });
    expect(calls[0].args).toEqual(["-m", "plimsoll.cli", "governor", "--json"]);
  });
});

describe("createPlimsollGovernor — honest degradation when the engine can't run", () => {
  it("is unavailable + FAIL-CLOSED by default (a spawn error blocks the call)", async () => {
    const log = vi.fn();
    const { run } = fakeSubprocess({ code: null, stdout: "", stderr: "", spawnError: new Error("spawn python3 ENOENT") });
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", subprocess: run, log });
    const d = await gov.check({ tool: "subscribe" });
    expect(d.outcome).toBe("unavailable");
    expect(d.allowed).toBe(false); // fail-closed: unknown ⇒ block
    expect(log).toHaveBeenCalledWith(expect.stringContaining("governor unavailable"));
  });

  it("is unavailable + FAIL-OPEN when configured (a spawn error allows the call)", async () => {
    const { run } = fakeSubprocess({ code: null, stdout: "", stderr: "", spawnError: new Error("ENOENT") });
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", failPolicy: "open", subprocess: run, log: () => {} });
    const d = await gov.check({ tool: "subscribe" });
    expect(d.outcome).toBe("unavailable");
    expect(d.allowed).toBe(true); // fail-open: unknown ⇒ allow
  });

  it("treats a usage error (exit 2, no decision JSON) as unavailable", async () => {
    const { run } = fakeSubprocess({ code: 2, stdout: "", stderr: "error: invalid JSON" });
    const gov = createPlimsollGovernor({ plimsollRoot: "/fake/plimsoll", subprocess: run, log: () => {} });
    const d = await gov.check({ tool: "subscribe" });
    expect(d.outcome).toBe("unavailable");
    expect(d.allowed).toBe(false);
  });

  it("is unavailable when PLIMSOLL_ROOT is not configured (never spawns)", async () => {
    const { run, calls } = fakeSubprocess(ALLOW);
    const gov = createPlimsollGovernor({ plimsollRoot: undefined, subprocess: run, log: () => {} });
    const d = await gov.check({ tool: "subscribe" });
    expect(d.outcome).toBe("unavailable");
    expect(calls).toHaveLength(0); // no point spawning without the engine root
  });
});
