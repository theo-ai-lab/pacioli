/**
 * Pacioli — /api/ingest endpoint logic (transport-free, so it's unit-testable).
 *
 * "REAL INGESTION": a FORWARDED merchant confirmation (an email-shaped payload — subject/from/body,
 * NOT pre-structured evidence) is parsed into MerchantEvidence here, reconciled against the user's
 * STATED authorization by the SAME deterministic engine as /api/reconcile (lib/engine), and returned
 * as a tamper-evident receipt. The thin route (app/api/ingest/route.ts) writes it to the caller's
 * per-user session ledger.
 *
 * Why a second endpoint vs /api/reconcile: /api/reconcile already takes STRUCTURED evidence (the
 * caller did the extraction). Ingest takes the UNSTRUCTURED confirmation a mail source actually
 * delivers and extracts the fields itself — that's the difference between a paste-in demo and a real
 * external system feeding the ledger.
 *
 * MOCK-TESTABLE, ZERO EXTERNAL DEPENDENCY: extraction (`extractEvidence`) is a pure function over the
 * payload and the reconcile path is the in-process engine. The email-FETCHING (Gmail MCP / inbound
 * webhook — see app/api/ingest/route.ts) lives in the CALLER, so this module and its tests never
 * touch the network. Tests drive it with fixture confirmation payloads.
 *
 * PRIVACY INVARIANT (packages/engine/src/types.ts): the raw confirmation body is parsed in-memory and DROPPED.
 * Only extracted fields + a short, redacted `excerpt` leave this function; the store persists less still.
 */
import { z } from "zod";
import { buildReceipt } from "@pacioli-app/engine";
import { UNREQUESTED_ADDON_KEYWORDS } from "@pacioli-app/engine";
import type { DiffInput, Finding, MerchantEvidence } from "@pacioli-app/engine";

export const IngestBody = z.object({
  agent: z.string().max(120).default("api"),
  /** The user's original instruction, verbatim (what was asked of the agent). */
  task: z.string().max(2000),
  /** The agent's natural-language report of what it did (the claim we audit the confirmation against). */
  claim: z.string().max(4000),
  /** What the user actually AUTHORIZED — the budget/scope to hold the agent to. Same shape as /reconcile. */
  authorized: z
    .object({
      budgetUsd: z.number().nullable().optional(),
      scope: z.string().max(400).optional(),
      constraints: z.array(z.string().max(200)).max(20).optional(),
      mayPurchase: z.boolean().optional(),
      mayRecur: z.boolean().optional(),
    })
    .default({}),
  /** The FORWARDED merchant confirmation — email-shaped, NOT pre-extracted evidence. */
  confirmation: z.object({
    /** Sender, e.g. `"Uber Receipts <receipts@uber.com>"` or a bare address. Best merchant signal. */
    from: z.string().max(320).default(""),
    subject: z.string().max(500).default(""),
    /** The plain-text confirmation body. Parsed then dropped — never persisted (PRIVACY INVARIANT). */
    body: z.string().max(20_000),
    /** The message date (ISO-ish). Preferred over any date parsed from the body. */
    receivedAt: z.string().max(40).nullable().optional(),
    /** Optional merchant a webhook/MCP already resolved; trusted over `from`/`subject` parsing. */
    merchantHint: z.string().max(200).optional(),
  }),
});

export type IngestInput = z.infer<typeof IngestBody>;
type Confirmation = IngestInput["confirmation"];

/** The success body — typed end-to-end so the route can't silently persist a renamed/dropped field. */
export interface IngestSuccess {
  agent: string;
  merchant: string;
  balanced: boolean;
  findings: Finding[];
  /** null (not omitted) when no amount was computable — one stable absence convention. */
  deltaUsd: number | null;
  likelyCause: string | null;
  receiptId: string;
  receiptHash: string;
  /** Always "email" here — the receipt was reconciled from a forwarded confirmation. */
  source: "email";
  /** What extraction read out of the confirmation, so the product surface can show its work. */
  evidence: MerchantEvidence;
}

export type IngestResponse =
  | { status: 200; body: IngestSuccess }
  | { status: 422; body: { error: string; issues: unknown } };

// ── Extraction primitives (deterministic, dependency-free) ────────────────────────────────────────

/** A currency amount in USD: `$1,234.56`, `USD 99`, `49.99 dollars`. One source string, reused
 *  global (extraction) and non-global (line membership) so a stateful lastIndex never leaks. */
const MONEY_SRC = String.raw`(?:\$|US\$|USD)\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*\.[0-9]{2})\s?(?:USD|usd|dollars)\b`;
const MONEY_TEST = new RegExp(MONEY_SRC, "i");

/** Lines whose amount is the CHARGE, not a component — prefer these when picking the total. */
const TOTAL_LABEL = /\b(grand total|order total|total|amount\s+(?:charged|paid|due)|amount|charged|you\s+paid|payment|charge)\b/i;
/** Component lines that are NOT line-items in their own right (kept out of `items`). */
const COMPONENT_LABEL = /\b(subtotal|sub-total|tax|vat|gst|tip|gratuity|fee|fees|shipping|discount|balance)\b/i;
/** Recurrence signals. Absence ⇒ a one-time charge. */
const RECUR = /\b(recurring|subscription|subscribe|auto[-\s]?renew|will\s+renew|renews|billed\s+(?:again|monthly|weekly|annually|yearly)|every\s+(?:month|week|year)|per\s+(?:month|week|year)|month?ly|weekly|annual(?:ly)?|yearly)\b|\/\s?(?:mo|month|wk|week|yr|year)\b/i;
/** Unrequested-add-on product keywords — imported from the engine so the lists can't drift. */
const ADDON = new RegExp(UNREQUESTED_ADDON_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
/** A bare ISO date fallback when the payload carries no `receivedAt`. */
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

const toNumber = (s: string): number => Number(s.replace(/,/g, ""));

/** Every USD amount in the text, paired with the line it appeared on. */
function amountsByLine(lines: string[]): Array<{ value: number; line: string }> {
  const out: Array<{ value: number; line: string }> = [];
  for (const line of lines) {
    const re = new RegExp(MONEY_SRC, "gi"); // fresh per line — no shared lastIndex
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = m[1] ?? m[2];
      if (raw === undefined) continue;
      const v = toNumber(raw);
      if (Number.isFinite(v)) out.push({ value: v, line });
    }
  }
  return out;
}

/** The amount the merchant actually charged: the largest total-labeled amount, else the largest
 *  amount anywhere (a receipt total is ≥ its components), else null when none is present. */
function pickChargedAmount(lines: string[]): number | null {
  const all = amountsByLine(lines);
  if (all.length === 0) return null;
  const labeled = all.filter((a) => TOTAL_LABEL.test(a.line) && !COMPONENT_LABEL.test(a.line));
  const pool = labeled.length > 0 ? labeled : all;
  return Math.max(...pool.map((a) => a.value));
}

/** Recurrence + its period, from the whole text. monthly is the default period when ambiguous. */
function detectRecurrence(text: string): { recurring: boolean; recurringPeriod?: MerchantEvidence["recurringPeriod"] } {
  if (!RECUR.test(text)) return { recurring: false };
  const recurringPeriod = /\b(week|wk|weekly)\b/i.test(text)
    ? "weekly"
    : /\b(year|yr|annual|annually|yearly)\b/i.test(text)
      ? "annual"
      : "monthly";
  return { recurring: true, recurringPeriod };
}

/** Merchant: an explicit hint wins; else the `from` display-name; else the address' second-level
 *  domain label; else the subject; else a stable "unknown merchant". */
function extractMerchant(c: Confirmation): string {
  if (c.merchantHint?.trim()) return c.merchantHint.trim().slice(0, 200);

  const display = c.from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  if (display?.[1]?.trim()) return display[1].trim().replace(/\s+/g, " ").slice(0, 200);

  const addr = c.from.match(/<?([^<>\s@]+)@([^<>\s]+?)>?$/) ?? c.from.match(/([^<>\s@]+)@([^<>\s]+)/);
  if (addr?.[2]) {
    const labels = addr[2].toLowerCase().replace(/[>.]+$/, "").split(".").filter(Boolean);
    const sld = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (sld) return sld.charAt(0).toUpperCase() + sld.slice(1);
  }
  if (c.subject.trim()) return c.subject.trim().replace(/\s+/g, " ").slice(0, 200);
  return "unknown merchant";
}

/** Line-items the engine can reason about (add-on detection, prohibition citation). Money-bearing
 *  lines that aren't totals/components, PLUS any add-on line even without a price. Bounded 50×200. */
function extractItems(lines: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) continue;
    const hasMoney = MONEY_TEST.test(t);
    const isAddon = ADDON.test(t);
    const isRollup = TOTAL_LABEL.test(t) || COMPONENT_LABEL.test(t);
    if (!((hasMoney && !isRollup) || isAddon)) continue;
    const clipped = t.slice(0, 200);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    items.push(clipped);
    if (items.length >= 50) break;
  }
  return items;
}

/** A short, redacted citation line: subject + the most salient body line. Email addresses and long
 *  digit runs (card / account numbers) are masked. Never the full body (PRIVACY INVARIANT). */
function buildExcerpt(c: Confirmation, lines: string[]): string {
  const salient =
    lines.find((l) => TOTAL_LABEL.test(l) && MONEY_TEST.test(l)) ??
    lines.find((l) => ADDON.test(l)) ??
    lines.find((l) => l.trim().length > 0) ??
    "";
  const redact = (s: string): string =>
    s
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "<email>")
      .replace(/\b\d[\d -]{5,}\d\b/g, "•••")
      .replace(/\s+/g, " ")
      .trim();
  return [redact(c.subject), redact(salient)].filter(Boolean).join(" — ").slice(0, 280);
}

/**
 * Parse a forwarded confirmation into the engine's MerchantEvidence. Pure + deterministic: same
 * payload ⇒ same evidence ⇒ same receipt hash. No external dependency, so it's fixture-testable.
 */
export function extractEvidence(c: Confirmation): MerchantEvidence {
  const lines = c.body.split(/\r?\n/);
  const haystack = `${c.subject}\n${c.body}`;
  const { recurring, recurringPeriod } = detectRecurrence(haystack);
  return {
    source: "email",
    merchant: extractMerchant(c),
    amountUsd: pickChargedAmount(lines),
    date: c.receivedAt?.trim() || c.body.match(ISO_DATE)?.[1] || null,
    items: extractItems(lines),
    recurring,
    recurringPeriod,
    excerpt: buildExcerpt(c, lines),
  };
}

/**
 * Validate the forwarded payload, extract evidence, reconcile it against the stated authorization,
 * and assemble the canonical receipt. Deterministic only (no LLM judge on this path) — the engine
 * does the work, with zero network.
 */
export async function ingestEndpoint(json: unknown): Promise<IngestResponse> {
  const parsed = IngestBody.safeParse(json);
  if (!parsed.success) return { status: 422, body: { error: "invalid body", issues: parsed.error.issues } };
  const b = parsed.data;

  const evidence = extractEvidence(b.confirmation);
  const input: DiffInput = {
    claim: { agent: b.agent, task: b.task, text: b.claim, authorized: b.authorized },
    evidence,
  };

  const r = await buildReceipt(input);

  return {
    status: 200,
    body: {
      agent: b.agent,
      merchant: evidence.merchant,
      balanced: r.verdict.balanced,
      findings: r.verdict.findings,
      deltaUsd: r.verdict.deltaUsd ?? null,
      likelyCause: r.likelyCause,
      receiptId: r.receiptId,
      receiptHash: r.receiptHash,
      source: "email",
      evidence,
    },
  };
}
