/**
 * Pacioli — PR reconciliation CLI (the FDE / agent-PR angle, made reachable).
 *
 *   tsx lib/adapters/pr-reconcile-cli.ts [pr.json] [--policy safe|stable-k] [--k N] [--json] [--gate]
 *
 * Reads a PR claim+evidence JSON ({ "claim": PullRequestClaim, "evidence"?: PullRequestEvidence }) from
 * a file arg or stdin and reconciles it INCREMENTALLY through the prefix reconciler: signal by signal
 * (contract → diff size → touched files → CI), it reports the EARLIEST prefix at which a verdict can be
 * committed — e.g. "this PR is 16× the agreed change budget, flag it before CI even runs" — and whether
 * that early commit is monotone-safe. With no input it runs a clearly-labelled DEMO PR.
 *
 *   --gate   exit non-zero if the FINAL verdict is flagged (drop into CI to fail a build on an agent PR
 *            that overspends its change budget or breaks a review-only mandate).
 *   --json   emit the full machine-readable run instead of the human trace.
 *
 * Deterministic; no key, no network. The fuzzy "claims tests pass vs CI" residual (CLAIM_MISMATCH) is
 * abstained here by design — it is the gated LLM judge's job, not this deterministic gate's.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildReceipt } from "@pacioli-app/engine";
import type { ReconcileRun } from "../engine/prefix-reconcile";
import {
  prToDiffInput,
  reconcilePullRequest,
  type PullRequestClaim,
  type PullRequestEvidence,
} from "./pr-reconcile";

export interface PrInput {
  claim: PullRequestClaim;
  evidence?: PullRequestEvidence;
}

/** A clearly-labelled sample: an agent opens a "small refactor" that balloons to 16× its change budget
 *  AND claims tests pass while CI fails. The size blow-out is deterministic (OVERSPEND, caught early);
 *  the "tests pass" lie is the abstained CLAIM_MISMATCH residual. Used only when no input is supplied. */
export const DEMO_PR: PrInput = {
  claim: {
    number: 128,
    title: "[DEMO] Small refactor of the auth helper",
    body: "Tiny cleanup — extracted a helper, no behavior change. All tests pass.",
    author: "demo-agent",
    task: "refactor the auth helper; keep it small",
    scope: "small, mechanical refactor",
    maxChangedLines: 50,
    mayModifyCode: true,
    claimsTestsPass: true,
    claimedBehaviors: ["no behavior change", "stays small"],
  },
  evidence: {
    additions: 740,
    deletions: 66,
    filesChanged: 19,
    touchedPaths: ["auth/helper.ts", "auth/session.ts", "billing/charge.ts", "schema/migrate.sql"],
    checksPassed: false,
    checksSummary: "4 of 12 checks failed",
  },
};

const STEP_LABELS = ["contract + PR header", "diff size", "touched files", "CI result"];

/** A short human-legible label for one signal (prefix) of the PR arrival stream. */
function stepLabel(i: number): string {
  return STEP_LABELS[i] ?? `signal ${i}`;
}

/** Render the incremental run as a human-readable trace. Pure — no I/O — so it is unit-testable. */
export function formatReport(
  run: ReconcileRun,
  claim: PullRequestClaim,
  opts: { policy: "safe" | "stable-k"; receiptId?: string } = { policy: "safe" },
): string {
  const lines: string[] = [];
  const slug = claim.number ? `PR #${claim.number}: ${claim.title}` : claim.title;
  lines.push("pacioli · incremental PR reconciliation");
  lines.push(`  ${slug}`);
  lines.push(`  author: ${claim.author}   policy: ${opts.policy}`);
  lines.push("");

  for (const s of run.steps) {
    const cls = s.verdictClass === "balanced" ? "balanced" : "FLAGGED ";
    const mark = s.committed ? `  ← committed (${s.reason})` : "";
    lines.push(`  signal ${s.step}  ${stepLabel(s.step).padEnd(20)} → ${cls}${mark}`);
  }
  lines.push("");

  const finalLabel = run.finalClass === "balanced" ? "BALANCED" : "OUT OF BALANCE";
  if (run.committedClass) {
    const where =
      run.committedEarly && run.commitAt !== null
        ? `committed at signal ${run.commitAt} (${run.committedReason})`
        : "committed at the final signal";
    const safe = run.heldToEnd ? ", held to the end" : " — but a later signal flipped it (NOT monotone-safe)";
    lines.push(`  Verdict: ${finalLabel} — ${where}${safe}.`);
  } else {
    lines.push(`  Verdict: ${finalLabel}.`);
  }

  if (run.finalVerdict.findings.length) {
    lines.push("  Findings:");
    for (const f of run.finalVerdict.findings) {
      lines.push(`    • ${f.type} — ${f.note}`);
    }
  }
  if (claim.claimsTestsPass) {
    lines.push(
      "  Note: the agent claims tests pass — CLAIM_MISMATCH vs CI is the gated LLM-judge residual, not checked by this deterministic gate.",
    );
  }
  if (opts.receiptId) lines.push(`  Receipt: ${opts.receiptId}`);
  return lines.join("\n");
}

interface CliOpts {
  file?: string;
  policy: "safe" | "stable-k";
  k?: number;
  json: boolean;
  gate: boolean;
}

export function parseArgs(argv: string[]): CliOpts {
  const policyIdx = argv.indexOf("--policy");
  const kIdx = argv.indexOf("--k");
  const policyRaw = policyIdx >= 0 ? argv[policyIdx + 1] : undefined;
  if (policyRaw !== undefined && policyRaw !== "safe" && policyRaw !== "stable-k") {
    process.stderr.write(`pacioli pr-reconcile · unknown --policy "${policyRaw}" (expected: safe | stable-k)\n`);
    process.exit(2);
  }
  const valueIdxs = new Set([policyIdx, kIdx].filter((i) => i >= 0).map((i) => i + 1));
  const file = argv.find((a, i) => !a.startsWith("--") && !valueIdxs.has(i));
  return {
    file,
    policy: policyRaw ?? "safe",
    k: kIdx >= 0 ? Number(argv[kIdx + 1]) : undefined,
    json: argv.includes("--json"),
    gate: argv.includes("--gate"),
  };
}

/** Resolve the PR input: an explicit file, else piped stdin, else the labelled demo. */
function loadInput(file: string | undefined): { input: PrInput; isDemo: boolean } {
  if (file) return { input: JSON.parse(readFileSync(file, "utf8")) as PrInput, isDemo: false };
  if (!process.stdin.isTTY) {
    const stdin = readFileSync(0, "utf8").trim();
    if (stdin) return { input: JSON.parse(stdin) as PrInput, isDemo: false };
  }
  return { input: DEMO_PR, isDemo: true };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { input, isDemo } = loadInput(opts.file);
  const evidence = input.evidence ?? {};
  const run = reconcilePullRequest(input.claim, evidence, { policy: opts.policy, k: opts.k });
  const { receiptId } = await buildReceipt(prToDiffInput(input.claim, evidence));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...run, receiptId }, null, 2) + "\n");
  } else {
    if (isDemo) process.stderr.write("pacioli pr-reconcile · no input given — running the [DEMO] PR (pipe JSON or pass a file)\n");
    process.stdout.write(formatReport(run, input.claim, { policy: opts.policy, receiptId }) + "\n");
  }

  // A flagged final verdict fails the gate — an agent PR that overspent its change budget or broke a
  // review-only mandate should not be merged silently.
  if (opts.gate && run.finalClass === "flagged") process.exit(1);
}

// Only run when invoked directly (tsx lib/adapters/pr-reconcile-cli.ts …); importing for tests is a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`pacioli pr-reconcile · ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
