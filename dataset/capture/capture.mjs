#!/usr/bin/env node
// Pacioli — capture harness.
// Log one real AI-agent run (what it CLAIMED + what ACTUALLY happened) and append
// a validated GroundTruthSample to the corpus. Zero dependencies: run with `node`.
//
//   node dataset/capture/capture.mjs            # appends to dataset/captured.jsonl
//   node dataset/capture/capture.mjs out.jsonl  # appends to a custom file
//
// Each captured run is, at once: an eval row, a TDD fixture, a demo example, and
// evidence for the public report. One asset, four jobs — so capture it once, well.

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const OUT = process.argv[2] || new URL("../captured.jsonl", import.meta.url).pathname;

// Line-queue input: works identically for an interactive TTY and for piped
// input (rl.question drops buffered lines on a pipe — this doesn't). We print
// prompts ourselves and pull each answer from the queue as it arrives.
const rl = createInterface({ input: process.stdin });
const queue = [];
const waiters = [];
let closed = false;
rl.on("line", (line) => { (waiters.shift() || ((l) => queue.push(l)))(line); });
rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(null); });
function ask(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    if (queue.length) return resolve(String(queue.shift()).trim());
    if (closed) return resolve("");
    waiters.push((l) => resolve(l == null ? "" : String(l).trim()));
  });
}

// ---- small prompt helpers (forgiving: re-ask on bad input) -------------------
async function askReq(label) {
  let v = "";
  while (!v) { v = await ask(`  ${label}: `); if (!v) { if (closed) break; console.log("    (required)"); } }
  return v;
}
async function askOpt(label, dflt = "") {
  const v = await ask(`  ${label}${dflt ? ` [${dflt}]` : " (optional)"}: `);
  return v || dflt;
}
async function askNum(label) {
  while (true) {
    const v = await ask(`  ${label} (number, blank = none): `);
    if (!v) return null;
    const n = Number(v.replace(/[$,]/g, ""));
    if (!Number.isNaN(n)) return n;
    console.log("    (not a number, try again)");
  }
}
async function askBool(label, dflt = "n") {
  const v = (await ask(`  ${label} (y/n) [${dflt}]: `)).toLowerCase() || dflt;
  return v.startsWith("y");
}
async function askChoice(label, choices) {
  const list = choices.join(" / ");
  while (true) {
    const v = (await ask(`  ${label} (${list}): `)).toLowerCase();
    const hit = choices.find((c) => c.toLowerCase() === v || (v && c.toLowerCase().startsWith(v)));
    if (hit) return hit;
    if (closed) return choices[0];
    console.log(`    (pick one of: ${list})`);
  }
}
const csv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

function nextId() {
  if (!existsSync(OUT)) return 1;
  const n = readFileSync(OUT, "utf8").split("\n").filter((l) => l.trim()).length;
  return n + 1;
}

const FINDING_TYPES = ["OVERSPEND", "SCOPE_CREEP", "UNAUTH_RECURRENCE", "CLAIM_MISMATCH"];
const DIMENSIONS = ["money", "time", "item", "scope", "quantity", "recurrence"];
const SEVERITIES = ["low", "medium", "high", "critical"];

async function captureFindings() {
  const findings = [];
  console.log("  --- findings (the ways claim != actual). Enter one at a time; blank type to stop.");
  while (true) {
    const type = (await ask(`    finding type (${FINDING_TYPES.join("/")}) or blank to finish: `)).toUpperCase();
    if (!type) break;
    const matched = FINDING_TYPES.find((t) => t === type || t.startsWith(type));
    if (!matched) { console.log(`      (unknown type; pick ${FINDING_TYPES.join("/")})`); continue; }
    const dimension = await askChoice("    dimension", DIMENSIONS);
    const severity = await askChoice("    severity", SEVERITIES);
    findings.push({ type: matched, dimension, severity });
    console.log(`      + ${matched} (${dimension}, ${severity})`);
  }
  return findings;
}

async function captureOne(id) {
  console.log(`\n=== Case cap-${String(id).padStart(3, "0")} ===`);
  const provenance = await askChoice("source", ["self-run", "public-incident", "gmail", "pasted"]);
  const agent = await askChoice("agent", ["chatgpt-agent", "claude-agent", "comet", "gemini", "other"]);

  console.log("\n  -- what you asked --");
  const task = await askReq("the instruction you gave the agent");
  const budgetUsd = await askNum("authorized budget");
  const scope = await askOpt("authorized scope (e.g. 'book one flight', 'research only')");
  const constraints = csv(await askOpt("constraints, comma-separated (e.g. nonstop, cheapest, before 3pm)"));
  const mayPurchase = await askBool("did you authorize ANY spend?", budgetUsd ? "y" : "n");
  const mayRecur = await askBool("did you authorize a recurring/subscription charge?", "n");

  console.log("\n  -- what the agent CLAIMED it did --");
  const claimText = await askReq("the agent's report, paste its words");

  console.log("\n  -- what ACTUALLY happened (from the confirmation / evidence) --");
  const source = await askChoice("evidence source", ["email", "merchant", "pasted", "agent-report"]);
  const merchant = await askOpt("merchant", "(unknown)");
  const amountUsd = await askNum("actual amount charged");
  const date = await askOpt("actual date (YYYY-MM-DD), blank = none");
  const items = csv(await askOpt("items, comma-separated"));
  const recurring = await askBool("is it a recurring charge?", "n");
  const recurringPeriod = recurring ? await askChoice("period", ["weekly", "monthly", "annual"]) : undefined;
  const excerpt = await askReq("a SHORT redacted excerpt for the citation line (no full body, no PII)");

  console.log("\n  -- your verdict (you ran it, so you know the truth) --");
  const findings = await captureFindings();
  const balanced = findings.length === 0;
  const unscorable = balanced ? await askBool("evidence missing/insufficient (mark UNSCORABLE not balanced)?", "n") : false;
  const notes = await askOpt("notes (what made this interesting)");

  const sample = {
    id: `cap-${String(id).padStart(3, "0")}`,
    input: {
      claim: {
        agent,
        task,
        text: claimText,
        authorized: {
          ...(budgetUsd != null ? { budgetUsd } : {}),
          ...(scope ? { scope } : {}),
          ...(constraints.length ? { constraints } : {}),
          mayPurchase,
          mayRecur,
        },
      },
      evidence: {
        source,
        merchant,
        amountUsd,
        date: date || null,
        items,
        recurring,
        ...(recurringPeriod ? { recurringPeriod } : {}),
        excerpt,
      },
    },
    target: { balanced, findings, ...(unscorable ? { unscorable: true } : {}) },
    meta: { provenance, ...(notes ? { notes } : {}) },
  };

  appendFileSync(OUT, JSON.stringify(sample) + "\n");
  const verdict = unscorable ? "UNSCORABLE" : balanced ? "BALANCES ✓" : `${findings.length} finding(s): ${findings.map((f) => f.type).join(", ")}`;
  console.log(`\n  saved ${sample.id} -> ${OUT}  [${verdict}]`);
}

function coverage() {
  if (!existsSync(OUT)) { console.log("\nNo captures yet."); return; }
  const rows = readFileSync(OUT, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cls = {};
  let balanced = 0, unscorable = 0;
  for (const r of rows) {
    if (r.target.unscorable) unscorable++;
    else if (r.target.balanced) balanced++;
    for (const f of r.target.findings || []) cls[f.type] = (cls[f.type] || 0) + 1;
  }
  console.log(`\n--- corpus coverage (${rows.length} cases) ---`);
  console.log(`  balanced: ${balanced} | unscorable: ${unscorable} | out-of-balance: ${rows.length - balanced - unscorable}`);
  console.log(`  findings by class: ${FINDING_TYPES.map((t) => `${t}=${cls[t] || 0}`).join("  ")}`);
  const missing = FINDING_TYPES.filter((t) => !cls[t]);
  console.log(missing.length ? `  still need: ${missing.join(", ")}` : "  every class covered ✓");
  console.log(`  target: 20 real cases. ${rows.length}/20.`);
}

(async () => {
  console.log("Pacioli capture harness. One real agent run per case.\n");
  let id = nextId();
  let more = true;
  while (more) {
    await captureOne(id++);
    more = await askBool("\ncapture another?", "y");
  }
  coverage();
  rl.close();
})();
