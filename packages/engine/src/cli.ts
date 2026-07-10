/**
 * Pacioli — the `pacioli` CLI over the zero-dep deterministic core.
 *
 *   pacioli reconcile <input.json | ->   [--json]
 *
 * Reads a DiffInput ({claim, evidence}), runs the deterministic engine, prints
 * the receipt. The exit code IS the verdict, so the command gates a pipeline:
 *
 *   0  balanced — the books reconcile
 *   1  out of balance — at least one cited finding
 *   2  usage, I/O, or validation error (nothing was reconciled)
 *
 * Deterministic rules only: CLAIM_MISMATCH is an explicit abstention here (the
 * LLM judge lives in the app, behind a key — never in this package).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReceipt } from "./receipt";
import type { DiffInput, Finding } from "./types";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
}

const USAGE = `pacioli — claim-vs-evidence reconciliation for AI agents (deterministic core)

Usage:
  pacioli reconcile <input.json | ->  [--json]
  pacioli --help | -h
  pacioli --version

Commands:
  reconcile   Run the deterministic engine over a {claim, evidence} JSON input
              read from a file (or stdin with '-') and print the receipt.

Options:
  --json      Emit the full receipt (verdict, findings, content hash, likely
              cause) as JSON instead of the human-readable summary.

Exit codes:
  0  balanced — the books reconcile
  1  out of balance — at least one cited finding
  2  usage, I/O, or validation error
`;

// ── input validation (the boundary; inside it the types are trusted) ─────────

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Structural problems with a would-be DiffInput; empty means usable. */
export function validateDiffInput(x: unknown): string[] {
  if (!isObj(x)) return ["input must be a JSON object of the shape {claim, evidence}"];
  const problems: string[] = [];

  const claim = x.claim;
  if (!isObj(claim)) {
    problems.push("claim: required object ({agent, task, text, authorized})");
  } else {
    for (const key of ["agent", "task", "text"] as const) {
      if (typeof claim[key] !== "string") problems.push(`claim.${key}: required string`);
    }
    if (!isObj(claim.authorized)) problems.push("claim.authorized: required object (may be {})");
  }

  const evidence = x.evidence;
  if (!isObj(evidence)) {
    problems.push("evidence: required object ({source, merchant, amountUsd, date, items, recurring, excerpt})");
  } else {
    for (const key of ["source", "merchant", "excerpt"] as const) {
      if (typeof evidence[key] !== "string") problems.push(`evidence.${key}: required string`);
    }
    if (typeof evidence.amountUsd !== "number" && evidence.amountUsd !== null)
      problems.push("evidence.amountUsd: required number or null");
    if (!Array.isArray(evidence.items) || evidence.items.some((i) => typeof i !== "string"))
      problems.push("evidence.items: required array of strings");
    if (typeof evidence.recurring !== "boolean") problems.push("evidence.recurring: required boolean");
  }

  return problems;
}

// ── rendering ─────────────────────────────────────────────────────────────────

const money = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

function renderFinding(f: Finding): string {
  return [
    `   - ${f.type} [${f.severity}/${f.dimension}] ${f.note}`,
    `       claimed: ${f.claimedRef}`,
    `       actual : ${f.actualRef}`,
  ].join("\n");
}

// ── the CLI ───────────────────────────────────────────────────────────────────

/** Run the CLI. Returns the process exit code; never throws on user error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("-") && a !== "-");
  const positional = argv.filter((a) => !a.startsWith("-") || a === "-");

  if (flags.includes("--help") || flags.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  if (flags.includes("--version")) {
    // dist/cli.js and src/cli.ts sit one level below the package root alike.
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    io.out(`${pkg.version}\n`);
    return 0;
  }
  if (argv.length === 0) {
    io.err(USAGE);
    return 2;
  }

  const unknownFlag = flags.find((f) => f !== "--json");
  if (unknownFlag) {
    io.err(`pacioli: unknown option "${unknownFlag}"\n\n${USAGE}`);
    return 2;
  }

  const [command, file, ...rest] = positional;
  if (command !== "reconcile") {
    io.err(`pacioli: unknown command "${command ?? ""}"\n\n${USAGE}`);
    return 2;
  }
  if (!file || rest.length > 0) {
    io.err(`pacioli: reconcile takes exactly one input file (or '-' for stdin)\n\n${USAGE}`);
    return 2;
  }

  let raw: string;
  try {
    raw = file === "-" ? await io.readStdin() : readFileSync(file, "utf8");
  } catch (e) {
    io.err(`pacioli: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    io.err(`pacioli: ${file === "-" ? "stdin" : file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const problems = validateDiffInput(parsed);
  if (problems.length > 0) {
    io.err(`pacioli: invalid input:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 2;
  }

  const receipt = await buildReceipt(parsed as unknown as DiffInput);
  const { verdict } = receipt;

  if (flags.includes("--json")) {
    io.out(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    const lines = [
      "PACIOLI RECEIPT",
      `  verdict : ${verdict.balanced ? "BALANCED" : "OUT OF BALANCE"}`,
      `  findings: ${verdict.findings.length}`,
      ...verdict.findings.map(renderFinding),
      ...(typeof verdict.deltaUsd === "number" ? [`  delta   : ${money(verdict.deltaUsd)}`] : []),
      ...(receipt.likelyCause ? [`  likely  : ${receipt.likelyCause}`] : []),
      `  receipt : ${receipt.receiptId}  (content-addressed; recompute to verify)`,
    ];
    io.out(lines.join("\n") + "\n");
  }

  return verdict.balanced ? 0 : 1;
}
