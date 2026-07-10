#!/usr/bin/env node
// Pacioli — publish the redacted PUBLIC projection of the real-capture corpus.
//
//   node dataset/capture/publish.mjs                       # captured.jsonl -> captured.public.jsonl
//   node dataset/capture/publish.mjs in.jsonl out.jsonl    # custom paths
//
// dataset/captured.jsonl (raw, gitignored) holds your real runs and may carry PII in the
// free-text fields you pasted. This step is what makes the headline rate STRANGER-VERIFIABLE
// without shipping personal data: it projects each headline-eligible row down to the contract
// fields ONLY (dataset/schema.ts — anything else is dropped, allowlist not blocklist), runs
// every free-text field through a PII redactor, validates every structured field against the
// contract (ISO date, finite money, enum sources/dimensions/severities — free text cannot ride
// out on a field the redactor never sees), and enforces that the excerpt is short. The
// output, dataset/captured.public.jsonl, is meant to be committed — after you read it.
//
// The redactor is a machine backstop for machine-detectable classes (emails, URLs, card
// numbers, phone numbers, long digit runs). It cannot recognize a name or a street address —
// capture-time discipline ("a SHORT redacted excerpt, no PII") stays the primary control,
// and you review the emitted file line by line before committing it. Zero dependencies.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FINDING_TYPES = ["OVERSPEND", "SCOPE_CREEP", "UNAUTH_RECURRENCE", "CLAIM_MISMATCH"];
const DIMENSIONS = ["money", "time", "item", "scope", "quantity", "recurrence"];
const SEVERITIES = ["low", "medium", "high", "critical"];
const RECURRING_PERIODS = ["weekly", "monthly", "annual"];
// Personal-capture evidence sources only. The contract's institutional sources
// (ftc/doj/court/press/…) mark public incidents — a self-run capture cannot carry them.
const CAPTURE_SOURCES = ["email", "merchant", "pasted", "agent-report", "calendar", "web"];
const HEADLINE_PROVENANCE = new Set(["self-run", "gmail"]); // the only rows worth publishing — and the firewall's

/** A citation excerpt longer than this is a pasted body, not an excerpt. Hard error, not a trim. */
export const EXCERPT_MAX = 300;

// ── PII redaction (deterministic, biased toward redacting) ─────────────────────
//
// Order matters: ISO dates are shielded first so the phone/number rules cannot eat
// them (the engine reconciles on dates and dollar amounts — those must survive).
export function redactFreeText(input) {
  if (typeof input !== "string" || input === "") return input;
  // Input NULs are dropped before anything else: the date shield below uses a
  // \u0000-delimited sentinel, and input-controlled NULs must never be able to
  // collide with it. NUL has no legitimate place in pasted evidence text.
  let s = input.replace(/\u0000/g, "");

  // Shield ISO dates (contract-relevant; restored at the end).
  const dates = [];
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => `\u0000${dates.push(m) - 1}\u0000`);

  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  s = s.replace(/\bhttps?:\/\/[^\s"')\]]+/gi, "[url]");
  s = s.replace(/\bwww\.[^\s"')\]]+/gi, "[url]");
  // Card: 13–19 digits, optionally grouped by single spaces/dashes.
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[card]");
  // Phone: NANP-ish 10 digits (optional +country), or international +XX with grouped
  // digits. The lookbehind/boundary pair keeps them from firing inside longer runs.
  s = s.replace(/(?<!\d)(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[phone]");
  s = s.replace(/(?<!\d)\+\d{1,3}(?:[ .-]\d{2,4}){2,4}\b/g, "[phone]");
  // Any remaining long digit run is an order / confirmation / account number.
  s = s.replace(/\b\d{6,}\b/g, "[number]");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => dates[Number(i)]);
}

// ── allowlist projection to the contract (dataset/schema.ts) ────────────────────

const r = redactFreeText;
const strArr = (xs) => (Array.isArray(xs) ? xs.map((x) => r(String(x))) : []);

/** Project one raw captured row to its public form. Throws on firewall/shape violations. */
export function toPublicRow(row) {
  const c = row?.input?.claim;
  const e = row?.input?.evidence;
  const t = row?.target;
  const m = row?.meta;
  if (!c || !e || !t || !m) throw new Error("missing input.claim/evidence, target, or meta");
  // Structured fields are VALIDATED, never trusted: the redactor only sees free text,
  // so a field that skips it (date, source, enums, money) must match the contract
  // exactly or the row does not publish. Hard errors, not warnings.
  if (e.amountUsd !== null && !Number.isFinite(e.amountUsd)) throw new Error("evidence.amountUsd must be a finite number or null");
  if (typeof e.recurring !== "boolean") throw new Error("evidence.recurring must be boolean");
  if (typeof t.balanced !== "boolean") throw new Error("target.balanced must be boolean");
  const date = e.date ?? null;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date)))
    throw new Error(`evidence.date must be ISO YYYY-MM-DD or null, got ${JSON.stringify(date)} — free text cannot ride out on the date field`);
  if (!CAPTURE_SOURCES.includes(e.source))
    throw new Error(`evidence.source ${JSON.stringify(e.source)} is not a personal-capture source (${CAPTURE_SOURCES.join("/")})`);
  if (e.recurringPeriod !== undefined && !RECURRING_PERIODS.includes(e.recurringPeriod))
    throw new Error(`unknown recurringPeriod ${JSON.stringify(e.recurringPeriod)} (${RECURRING_PERIODS.join("/")})`);
  const ab = c.authorized?.budgetUsd;
  if (ab !== undefined && !Number.isFinite(ab)) throw new Error("authorized.budgetUsd must be a finite number");
  for (const f of t.findings || []) {
    if (!FINDING_TYPES.includes(f.type)) throw new Error(`unknown finding type ${f.type}`);
    if (!DIMENSIONS.includes(f.dimension)) throw new Error(`unknown finding dimension ${JSON.stringify(f.dimension)}`);
    if (!SEVERITIES.includes(f.severity)) throw new Error(`unknown finding severity ${JSON.stringify(f.severity)}`);
  }
  const excerpt = String(e.excerpt ?? "");
  // FIREWALL: a synthetic excerpt can never be published as a real capture.
  if (/\[SYNTHETIC\]/i.test(excerpt)) throw new Error("a [SYNTHETIC] excerpt cannot be published as a real capture");
  if (excerpt.length > EXCERPT_MAX) throw new Error(`excerpt is ${excerpt.length} chars (max ${EXCERPT_MAX}) — that is a body, not an excerpt`);

  const a = c.authorized ?? {};
  return {
    id: String(row.id),
    input: {
      claim: {
        agent: String(c.agent ?? "unknown"),
        task: r(String(c.task ?? "")),
        text: r(String(c.text ?? "")),
        authorized: {
          ...(a.budgetUsd !== undefined ? { budgetUsd: a.budgetUsd } : {}),
          ...(a.scope !== undefined ? { scope: r(String(a.scope)) } : {}),
          ...(a.constraints !== undefined ? { constraints: strArr(a.constraints) } : {}),
          ...(a.mayPurchase !== undefined ? { mayPurchase: Boolean(a.mayPurchase) } : {}),
          ...(a.mayRecur !== undefined ? { mayRecur: Boolean(a.mayRecur) } : {}),
        },
      },
      evidence: {
        source: e.source, // validated against CAPTURE_SOURCES above
        merchant: r(String(e.merchant ?? "(unknown)")),
        amountUsd: e.amountUsd,
        date, // validated ISO-or-null above

        items: strArr(e.items),
        recurring: e.recurring,
        ...(e.recurringPeriod !== undefined ? { recurringPeriod: e.recurringPeriod } : {}),
        excerpt: r(excerpt),
      },
    },
    target: {
      balanced: t.balanced,
      findings: (t.findings || []).map((f) => ({ type: f.type, dimension: f.dimension, severity: f.severity })),
      ...(t.unscorable ? { unscorable: true } : {}),
    },
    meta: {
      provenance: m.provenance,
      ...(m.notes !== undefined ? { notes: r(String(m.notes)) } : {}),
    },
  };
}

/** Publish a whole corpus (JSONL text) → { rows, skipped, errors }. Hard errors block publishing. */
export function publishCorpus(text) {
  const rows = [], skipped = [], errors = [];
  let ln = 0;
  for (const raw of String(text).split("\n")) {
    ln++;
    if (!raw.trim()) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      errors.push(`L${ln}: not valid JSON`);
      continue;
    }
    const id = row?.id ?? `L${ln}`;
    if (!HEADLINE_PROVENANCE.has(row?.meta?.provenance)) {
      skipped.push({ id, reason: `provenance "${row?.meta?.provenance}" is not headline-eligible (only self-run/gmail publish)` });
      continue;
    }
    try {
      rows.push(toPublicRow(row));
    } catch (err) {
      errors.push(`L${ln} ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rows, skipped, errors };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

function main() {
  const IN = process.argv[2] || new URL("../captured.jsonl", import.meta.url).pathname;
  const OUT = process.argv[3] || new URL("../captured.public.jsonl", import.meta.url).pathname;

  if (!existsSync(IN)) {
    console.error(`No capture file at ${IN}. Run \`npm run capture\` first — there is nothing to publish.`);
    process.exit(1);
  }
  const { rows, skipped, errors } = publishCorpus(readFileSync(IN, "utf8"));

  console.log(`\nPACIOLI — capture publish (${IN.split("/").pop()} → ${OUT.split("/").pop()})`);
  console.log(`  rows read: ${rows.length + skipped.length + errors.length} | publishable: ${rows.length} | skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`   ⚠ skipped ${s.id}: ${s.reason}`);
  if (errors.length) {
    console.error("\n  ERRORS (nothing written):");
    for (const e of errors) console.error("   ✗ " + e);
    process.exit(1);
  }
  if (rows.length === 0) {
    console.error("\n  ✗ no headline-eligible rows to publish (only self-run/gmail provenance counts).");
    process.exit(1);
  }
  writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(`\n  wrote ${rows.length} redacted row(s) → ${OUT}`);
  console.log("  Now: (1) read the file line by line — the redactor cannot recognize names or addresses;");
  console.log("       (2) `npm run capture:validate -- dataset/captured.public.jsonl`; (3) commit it.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
