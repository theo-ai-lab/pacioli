/**
 * Pacioli — the PRE-ACT governor gate: Plimsoll's deterministic governor wired UNDER the Steward.
 *
 * This is a GENUINE cross-tool integration, not a re-implementation. Before the Steward executes a
 * commerce tool call (agent/loop.ts), it asks Plimsoll — a separate, zero-dependency pure-Python 3.11
 * engine in its own repo — whether the proposed call is allowed under a policy. We shell out to its
 * deterministic CLI:
 *
 *     <python> -m plimsoll.cli governor --json [--policy <path>]      (proposed call as JSON on stdin)
 *
 * with PYTHONPATH pointed at the Plimsoll source root. The CLI exit code is the contract (Plimsoll's
 * own convention): 0 = allow, 1 = block, 2 = usage/input error. We trust the machine-readable JSON it
 * prints on stdout (`{ allowed, decision, blocking_findings, summary }`).
 *
 * This demonstrates Plimsoll's actual thesis — a provable, deterministic floor UNDER an LLM agent's
 * tool calls — in a live loop. It is a DEMONSTRATION harness, not a production deployment: a real
 * deployment would run the governor as a long-lived MCP server (plimsoll-governor) or in-process,
 * not spawn a subprocess per call. We do NOT require the optional `mcp` package — the core CLI path is
 * zero-dependency, which is exactly what makes spawning it cheap and hermetic.
 *
 * NO LLM, no network: the governor verdict is pure and deterministic. The only external dependency is
 * a Python 3.11+ interpreter and the Plimsoll source. When either is missing the gate degrades
 * HONESTLY (outcome "unavailable") and applies a configured fail policy — fail-CLOSED by default, so an
 * unknown answer blocks rather than waves the call through.
 */

import { spawn } from "node:child_process";

// ── The proposed call + the decision ────────────────────────────────────────────────────────────────

/** A tool call the Steward is ABOUT to make, described before it executes. Mirrors the fields
 *  Plimsoll's governor reads (tool name + the cost hints its budget rules account for). */
export interface ProposedToolCall {
  tool: string;
  input?: unknown;
  /** Marginal cost of this call in USD — the governor's budget rule (max_estimated_cost_usd) gates on it. */
  estimated_cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
}

export type GovernorOutcome = "allow" | "block" | "unavailable";

export interface GovernorDecision {
  outcome: GovernorOutcome;
  /** The single bit the loop acts on. For "unavailable" this is the fail policy's answer. */
  allowed: boolean;
  /** Plimsoll rule_ids that blocked the call (e.g. ["max_estimated_cost_usd"], ["forbidden_tool"]). */
  blockingRules: string[];
  reason: string;
  /** The raw governor JSON, when we got a parseable one (kept for the trace / audit). */
  raw?: unknown;
}

/** The injectable gate the Steward consults before each tool call. */
export interface GovernorGate {
  check(call: ProposedToolCall): Promise<GovernorDecision>;
}

// ── The subprocess seam (injectable so the gate is unit-testable without a real spawn) ───────────────

export interface SubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned or did not run to completion (ENOENT, timeout, …). */
  spawnError?: Error;
}

export type Subprocess = (
  command: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
) => Promise<SubprocessResult>;

/** The real spawner: runs the interpreter, feeds the call on stdin, collects stdout/stderr. Never
 *  rejects — every failure mode (spawn error, timeout) comes back as a resolved {spawnError}. */
export const defaultSubprocess: Subprocess = (command, args, opts) =>
  new Promise<SubprocessResult>((resolve) => {
    let settled = false;
    const finish = (r: SubprocessResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", spawnError: err as Error });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ code: null, stdout, stderr, spawnError: new Error(`governor timed out after ${opts.timeoutMs}ms`) });
    }, opts.timeoutMs);
    timer.unref?.();

    proc.stdout?.on("data", (d) => (stdout += String(d)));
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, spawnError: err });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });

    // Feed the proposed call on stdin. Swallow EPIPE — if the child already exited, the close/error
    // handler above carries the real outcome.
    proc.stdin?.on("error", () => {});
    try {
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    } catch {
      /* handled by the error/close listeners */
    }
  });

// ── The Plimsoll governor gate ───────────────────────────────────────────────────────────────────────

export interface PlimsollGovernorOptions {
  /** Path to a Python 3.11+ interpreter. Default: env PLIMSOLL_PYTHON, else "python3". */
  python?: string;
  /** Plimsoll source root, added to PYTHONPATH. Default: env PLIMSOLL_ROOT. When absent the gate cannot
   *  run, so it reports "unavailable" and applies the fail policy. */
  plimsollRoot?: string;
  /** Policy JSON passed to `--policy`. Default: env PLIMSOLL_POLICY. Absent = Plimsoll's permissive
   *  empty policy (nothing gated). */
  policyPath?: string;
  /** What to do when the governor is UNAVAILABLE (no python/plimsoll, spawn/parse error). Default
   *  "closed": an unknown verdict blocks the call. "open": an unknown verdict allows it. */
  failPolicy?: "closed" | "open";
  /** Hard timeout per call (ms). Default 5000. */
  timeoutMs?: number;
  /** Injectable subprocess runner (tests pass a fake; production uses defaultSubprocess). */
  subprocess?: Subprocess;
  /** Where to log the "governor unavailable" line. Default console.error. */
  log?: (msg: string) => void;
}

interface GovernorJson {
  allowed?: boolean;
  decision?: string;
  summary?: string;
  blocking_findings?: Array<{ rule_id?: string; message?: string }>;
}

/** Build a GovernorGate that shells out to Plimsoll's deterministic `governor` CLI. */
export function createPlimsollGovernor(opts: PlimsollGovernorOptions = {}): GovernorGate {
  const python = opts.python ?? process.env.PLIMSOLL_PYTHON ?? "python3";
  const plimsollRoot = opts.plimsollRoot ?? process.env.PLIMSOLL_ROOT;
  const policyPath = opts.policyPath ?? process.env.PLIMSOLL_POLICY;
  const failPolicy = opts.failPolicy ?? "closed";
  const timeoutMs = opts.timeoutMs ?? 5000;
  const run = opts.subprocess ?? defaultSubprocess;
  const log = opts.log ?? ((m: string) => console.error(m));

  const unavailable = (reason: string): GovernorDecision => {
    log(`governor unavailable (${failPolicy === "closed" ? "fail-closed → block" : "fail-open → allow"}): ${reason}`);
    return { outcome: "unavailable", allowed: failPolicy === "open", blockingRules: [], reason };
  };

  return {
    async check(call: ProposedToolCall): Promise<GovernorDecision> {
      if (!plimsollRoot) {
        return unavailable("PLIMSOLL_ROOT is not set (cannot locate the Plimsoll engine)");
      }

      const args = ["-m", "plimsoll.cli", "governor", "--json"];
      if (policyPath) args.push("--policy", policyPath);

      // Prepend the Plimsoll source to PYTHONPATH so `import plimsoll` resolves without an install.
      const existing = process.env.PYTHONPATH;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONPATH: existing ? `${plimsollRoot}:${existing}` : plimsollRoot,
      };

      const stdin = JSON.stringify(compactCall(call));
      const result = await run(python, args, { env, stdin, timeoutMs });

      if (result.spawnError) {
        return unavailable(`${result.spawnError.message} (python='${python}')`);
      }

      const parsed = tryParse(result.stdout);
      if (parsed && typeof parsed.allowed === "boolean") {
        const rules = (parsed.blocking_findings ?? []).map((f) => f.rule_id ?? "?").filter(Boolean);
        return parsed.allowed
          ? { outcome: "allow", allowed: true, blockingRules: [], reason: parsed.summary ?? "allowed", raw: parsed }
          : {
              outcome: "block",
              allowed: false,
              blockingRules: rules,
              reason: parsed.summary ?? `blocked by ${rules.join(", ") || "policy"}`,
              raw: parsed,
            };
      }

      // No parseable decision (e.g. exit 2 = governor usage/input error, or a crash): we cannot be
      // sure, so honour the fail policy rather than guess.
      return unavailable(`no decision JSON (exit ${result.code ?? "null"}): ${result.stderr.trim().slice(0, 200)}`);
    },
  };
}

/** Drop undefined cost hints so the stdin JSON is the minimal call the governor expects. */
function compactCall(call: ProposedToolCall): Record<string, unknown> {
  const out: Record<string, unknown> = { tool: call.tool };
  if (call.input !== undefined) out.input = call.input;
  if (call.estimated_cost_usd !== undefined) out.estimated_cost_usd = call.estimated_cost_usd;
  if (call.input_tokens !== undefined) out.input_tokens = call.input_tokens;
  if (call.output_tokens !== undefined) out.output_tokens = call.output_tokens;
  if (call.duration_ms !== undefined) out.duration_ms = call.duration_ms;
  return out;
}

function tryParse(text: string): GovernorJson | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as GovernorJson;
  } catch {
    return null;
  }
}
