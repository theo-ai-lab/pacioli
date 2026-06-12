#!/usr/bin/env node
// Pacioli — validate the real-capture corpus before it drives the headline number.
// Checks each row's shape + the provenance firewall, and previews the rate (with a 95% CI).
//   node dataset/capture/validate.mjs            # validates dataset/captured.jsonl
//   node dataset/capture/validate.mjs file.jsonl
// Exits non-zero on any hard error. Zero dependencies.

import { existsSync, readFileSync } from "node:fs";

const FILE = process.argv[2] || new URL("../captured.jsonl", import.meta.url).pathname;
const FINDING_TYPES = ["OVERSPEND", "SCOPE_CREEP", "UNAUTH_RECURRENCE", "CLAIM_MISMATCH"];
const HEADLINE_PROVENANCE = new Set(["self-run", "gmail"]); // the only provenance the firewall counts

function wilson(s, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = s / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

if (!existsSync(FILE)) {
  console.log(`No capture file at ${FILE}. Run \`npm run capture\` first.`);
  process.exit(0);
}

const lines = readFileSync(FILE, "utf8").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => l.trim());
const errors = [], warnings = [], rows = [];

for (const [ln, raw] of lines) {
  let r;
  try { r = JSON.parse(raw); } catch { errors.push(`L${ln}: not valid JSON`); continue; }
  const c = r?.input?.claim, e = r?.input?.evidence, t = r?.target, m = r?.meta;
  if (!c || !e || !t || !m) { errors.push(`L${ln} ${r?.id || "?"}: missing input.claim/evidence, target, or meta`); continue; }
  if (typeof e.amountUsd !== "number" && e.amountUsd !== null) errors.push(`L${ln} ${r.id}: evidence.amountUsd must be a number or null`);
  if (typeof e.recurring !== "boolean") errors.push(`L${ln} ${r.id}: evidence.recurring must be boolean`);
  if (typeof t.balanced !== "boolean") errors.push(`L${ln} ${r.id}: target.balanced must be boolean`);
  for (const f of t.findings || []) if (!FINDING_TYPES.includes(f.type)) errors.push(`L${ln} ${r.id}: unknown finding type ${f.type}`);
  // FIREWALL: captured.jsonl holds REAL commissioned runs. Synthetic must never masquerade as real.
  if (!HEADLINE_PROVENANCE.has(m.provenance))
    warnings.push(`L${ln} ${r.id}: provenance "${m.provenance}" is NOT headline-eligible (only self-run/gmail count)`);
  if (/\[SYNTHETIC\]/i.test(e.excerpt || ""))
    errors.push(`L${ln} ${r.id}: a [SYNTHETIC] excerpt cannot be a real capture (firewall violation)`);
  rows.push(r);
}

const real = rows.filter((r) => HEADLINE_PROVENANCE.has(r.meta.provenance));
const scorable = real.filter((r) => !r.target.unscorable);
const misbehaved = scorable.filter((r) => !r.target.balanced).length;

console.log(`\nPACIOLI — capture validation (${FILE.split("/").pop()})`);
console.log(`  rows: ${rows.length} | headline-eligible: ${real.length} | scorable: ${scorable.length}`);
if (warnings.length) { console.log("\n  warnings:"); for (const w of warnings) console.log("   ⚠ " + w); }
if (errors.length) { console.log("\n  ERRORS:"); for (const e of errors) console.log("   ✗ " + e); }

console.log("\n  --- headline preview (what will render on /methods) ---");
if (scorable.length === 0) console.log("  no real scorable runs yet → shows 'pending live captures'");
else if (scorable.length < 8) console.log(`  ${misbehaved}/${scorable.length} misbehaved (need ≥8 real runs before a confidence interval shows)`);
else {
  const [lo, hi] = wilson(misbehaved, scorable.length);
  console.log(`  ${misbehaved}/${scorable.length} → ≈${Math.round((misbehaved / scorable.length) * 100)}% misbehaved (95% CI ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`);
}

if (errors.length) process.exit(1);
console.log(`\n  ✓ valid${real.length < 10 ? `  ·  target ≥10–30 real runs for a publishable rate (have ${real.length})` : ""}`);
