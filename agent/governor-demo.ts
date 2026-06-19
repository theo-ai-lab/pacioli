/**
 * Pacioli × Plimsoll — the REAL round trip: a deterministic governor as a PRE-ACT floor under the
 * Steward, demonstrated by spawning Plimsoll's actual `governor` CLI for every decision.
 *
 * `npm run steward:governed` runs this. It:
 *   1) makes a few DIRECT governor calls (a real allow + real denials) straight from the CLI, then
 *   2) runs the full Steward loop with the real governor wired in: a priciest-first agent reaches for
 *      the over-budget plan, the governor DENIES it before any charge, and the agent self-corrects.
 *
 * This is a DEMONSTRATION harness, not a production deployment — a real system would run the governor
 * as a long-lived MCP server (plimsoll-governor) or in-process rather than spawn a subprocess per call.
 * It is honest about availability: if Python 3.11 + the Plimsoll source are not reachable, it says so
 * and exits non-zero rather than fake a verdict.
 *
 * Config (all overridable by env):
 *   PLIMSOLL_ROOT    Plimsoll source root            (default: the sibling ../plimsoll checkout)
 *   PLIMSOLL_PYTHON  Python 3.11+ interpreter         (default: python3)
 *   PLIMSOLL_POLICY  governor policy JSON             (default: agent/governor-policy.json)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlimsollGovernor, type ProposedToolCall } from "./governor";
import { createMockCommerceClient } from "./tools";
import { runSteward, scriptedStewardModel, subscribeUnderBudget } from "./loop";

const here = path.dirname(fileURLToPath(import.meta.url));
const plimsollRoot = process.env.PLIMSOLL_ROOT ?? path.resolve(here, "..", "..", "plimsoll");
const python = process.env.PLIMSOLL_PYTHON ?? "python3";
const policyPath = process.env.PLIMSOLL_POLICY ?? path.join(here, "governor-policy.json");

async function main(): Promise<void> {
  console.log("Steward × Plimsoll — a deterministic governor as a PRE-ACT floor (REAL round trip).\n");
  console.log(`  python:       ${python}`);
  console.log(`  plimsollRoot: ${plimsollRoot}`);
  console.log(`  policy:       ${policyPath}\n`);

  const governor = createPlimsollGovernor({ python, plimsollRoot, policyPath, failPolicy: "closed" });

  // 1) Direct governor verdicts — a real ALLOW and real DENYs straight from the spawned CLI.
  console.log("=== direct governor verdicts (each spawns `python -m plimsoll.cli governor`) ===");
  const checks: Array<{ label: string; call: ProposedToolCall }> = [
    { label: "in-budget subscribe  ($15)", call: { tool: "subscribe", estimated_cost_usd: 15, input: { planId: "plan_standard" } } },
    { label: "over-budget subscribe ($30)", call: { tool: "subscribe", estimated_cost_usd: 30, input: { planId: "plan_premium" } } },
    { label: "forbidden tool (wire_transfer)", call: { tool: "wire_transfer" } },
    { label: "off-allowlist tool (buy)", call: { tool: "buy", estimated_cost_usd: 5 } },
  ];
  let anyUnavailable = false;
  for (const { label, call } of checks) {
    const d = await governor.check(call);
    if (d.outcome === "unavailable") anyUnavailable = true;
    const verb = d.allowed ? "ALLOW" : "DENY ";
    const why = d.blockingRules.length ? ` (${d.blockingRules.join(", ")})` : "";
    console.log(`  [${verb}] ${label} → ${d.outcome}${why}`);
  }

  if (anyUnavailable) {
    console.error("\nGovernor UNAVAILABLE — Python 3.11 + the Plimsoll source were not reachable.");
    console.error("This is NOT a real round trip. Set PLIMSOLL_ROOT (and PLIMSOLL_PYTHON) and retry.");
    process.exit(1);
  }

  // 2) The live governed loop — the priciest-first agent reaches for Premium ($30); the governor DENIES
  //    it before any charge, and the agent self-corrects to a permitted plan that reconciles balanced.
  console.log("\n=== governed Steward loop (priciest-first agent under the real governor) ===");
  const client = createMockCommerceClient();
  const r = await runSteward({
    goal: subscribeUnderBudget(20),
    model: scriptedStewardModel({ preference: "priciest" }),
    client,
    governor,
  });
  for (const s of r.trace) {
    const tag = s.governorBlocked ? "⛔" : s.balanced === true ? "✅" : s.balanced === false ? "⚠️ " : "··";
    console.log(`  ${tag} step ${s.step}: ${s.note}`);
  }
  console.log(
    `outcome=${r.outcome} success=${r.success} steps=${r.steps} corrections=${r.corrections}` +
      (r.receiptId ? ` receipt=${r.receiptId}` : ""),
  );

  console.log("\nDivision of labor: the governor is the deterministic PRE-ACT floor (it stopped the");
  console.log("knowable-bad $30 call before any charge); the in-loop reconcile is the POST-ACT conscience");
  console.log("(it catches what only the evidence reveals, e.g. a hidden surcharge). Same Plimsoll engine,");
  console.log("evaluated at the gate. This is a demonstration, not a production deployment.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
