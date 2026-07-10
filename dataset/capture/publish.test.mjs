// Tests for the capture:publish redaction path (dataset/capture/publish.mjs).
//
// The publish step is the bridge across the provenance firewall: the raw private
// corpus (dataset/captured.jsonl, gitignored) is projected down to CONTRACT FIELDS
// ONLY, every free-text field passes a PII redactor, and the short excerpt is
// enforced short — so dataset/captured.public.jsonl can be committed and a
// stranger can re-score the headline rate without ever seeing personal data.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { EXCERPT_MAX, redactFreeText, toPublicRow, publishCorpus } from "./publish.mjs";

// ── a minimal, valid private row (what capture.mjs writes) ─────────────────────
function privateRow(overrides = {}) {
  const base = {
    id: "cap-001",
    input: {
      claim: {
        agent: "chatgpt-agent",
        task: "book one nonstop flight under $400",
        text: "Booked a nonstop flight for $438.20.",
        authorized: { budgetUsd: 400, scope: "book one flight", constraints: ["nonstop"], mayPurchase: true, mayRecur: false },
      },
      evidence: {
        source: "email",
        merchant: "United Airlines",
        amountUsd: 438.2,
        date: "2026-07-08",
        items: ["flight", "seat fee"],
        recurring: false,
        excerpt: "Your confirmation: flight + Economy Plus seat, total $438.20 charged 2026-07-08.",
      },
    },
    target: { balanced: false, findings: [{ type: "OVERSPEND", dimension: "money", severity: "medium" }] },
    meta: { provenance: "self-run", notes: "seat fee pushed it over budget" },
  };
  return JSON.parse(JSON.stringify({ ...base, ...overrides }));
}

describe("redactFreeText", () => {
  it("redacts email addresses", () => {
    expect(redactFreeText("receipt sent to jane.doe+ai@example.com today")).toBe("receipt sent to [email] today");
  });

  it("redacts URLs (query strings can carry tokens)", () => {
    expect(redactFreeText("see https://merchant.example/order?id=abc&token=s3cr3t for details")).toBe(
      "see [url] for details",
    );
    expect(redactFreeText("at www.merchant.example/orders/view")).toBe("at [url]");
  });

  it("redacts card-like digit sequences", () => {
    expect(redactFreeText("card 4242 4242 4242 4242 on file")).toBe("card [card] on file");
    expect(redactFreeText("card 4242-4242-4242-4242")).toBe("card [card]");
    expect(redactFreeText("card 4242424242424242")).toBe("card [card]");
  });

  it("redacts phone numbers", () => {
    expect(redactFreeText("call +1 (555) 123-4567 to cancel")).toBe("call [phone] to cancel");
    expect(redactFreeText("support: +44 20 7946 0958")).toBe("support: [phone]");
  });

  it("redacts long digit runs (order / confirmation numbers)", () => {
    expect(redactFreeText("confirmation 72301884930 issued")).toBe("confirmation [number] issued");
  });

  it("preserves money amounts, ISO dates, and small numbers — the fields the engine reconciles on", () => {
    const s = "charged $438.20 vs the $360 budget on 2026-07-08, seat 12A, 2 items";
    expect(redactFreeText(s)).toBe(s);
  });

  it("does not mistake a sentence boundary for a phone separator", () => {
    const s = "total was $438.20. 2026 pricing applied";
    expect(redactFreeText(s)).toBe(s);
  });

  it("strips NUL bytes from input so a hostile row cannot collide with the date shield", () => {
    // The shield's internal sentinel is \u0000<index>\u0000. If input-controlled NULs
    // survived, an attacker-shaped row could splice shielded dates into chosen slots
    // (or surface "undefined"). NUL has no legitimate place in pasted text: drop it.
    expect(redactFreeText("ref \u00000\u0000 charged on 2026-07-08")).toBe("ref 0 charged on 2026-07-08");
    expect(redactFreeText("a\u0000b")).toBe("ab");
  });
});

describe("publish.mjs source hygiene", () => {
  it("stays plain text — no control bytes that would make git/GitHub treat it as binary", () => {
    // Regression lock: the date-shield sentinel must be written as the \u0000 ESCAPE
    // in source, never as a raw byte — a raw NUL turns the file binary for diffing.
    const src = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
    const control = [...src].filter((ch) => ch < " " && ch !== "\n" && ch !== "\t");
    expect(control).toEqual([]);
  });
});

describe("toPublicRow", () => {
  it("keeps the scoring-relevant contract fields verbatim", () => {
    const pub = toPublicRow(privateRow());
    expect(pub.id).toBe("cap-001");
    expect(pub.input.evidence.amountUsd).toBe(438.2);
    expect(pub.input.evidence.date).toBe("2026-07-08");
    expect(pub.input.evidence.recurring).toBe(false);
    expect(pub.input.claim.authorized.budgetUsd).toBe(400);
    expect(pub.target).toEqual({ balanced: false, findings: [{ type: "OVERSPEND", dimension: "money", severity: "medium" }] });
    expect(pub.meta.provenance).toBe("self-run");
  });

  it("drops every field that is not part of the contract (allowlist projection)", () => {
    const row = privateRow();
    row.rawEmailBody = "full body with PII";
    row.input.claim.sessionCookie = "abc";
    row.input.evidence.headers = { "x-user": "jane" };
    row.meta.operator = "jane doe";
    const pub = toPublicRow(row);
    expect(pub.rawEmailBody).toBeUndefined();
    expect(pub.input.claim.sessionCookie).toBeUndefined();
    expect(pub.input.evidence.headers).toBeUndefined();
    expect(pub.meta.operator).toBeUndefined();
  });

  it("redacts PII in every free-text field", () => {
    const row = privateRow();
    row.input.claim.text = "Booked; confirmation sent to jane@example.com, ref 72301884930.";
    row.input.evidence.excerpt = "Charged $438.20 — questions? call +1 (555) 123-4567";
    row.meta.notes = "used my card 4242 4242 4242 4242";
    const pub = toPublicRow(row);
    expect(pub.input.claim.text).toBe("Booked; confirmation sent to [email], ref [number].");
    expect(pub.input.evidence.excerpt).toBe("Charged $438.20 — questions? call [phone]");
    expect(pub.meta.notes).toBe("used my card [card]");
  });

  it("omits optional fields that are absent instead of inventing them", () => {
    const row = privateRow();
    delete row.input.claim.authorized.budgetUsd;
    delete row.meta.notes;
    const pub = toPublicRow(row);
    expect("budgetUsd" in pub.input.claim.authorized).toBe(false);
    expect("notes" in pub.meta).toBe(false);
    expect("recurringPeriod" in pub.input.evidence).toBe(false);
    expect("unscorable" in pub.target).toBe(false);
  });

  it("throws on a [SYNTHETIC] excerpt — the firewall, not a warning", () => {
    const row = privateRow();
    row.input.evidence.excerpt = "[SYNTHETIC] confirmation text";
    expect(() => toPublicRow(row)).toThrow(/SYNTHETIC/);
  });

  it("throws when the excerpt is longer than EXCERPT_MAX (a full body is not an excerpt)", () => {
    const row = privateRow();
    row.input.evidence.excerpt = "x".repeat(EXCERPT_MAX + 1);
    expect(() => toPublicRow(row)).toThrow(/excerpt/i);
  });

  // ── structured fields are validated, not passed through — free text must not
  //    be able to ride out of the firewall on a field the redactor never sees ──

  it("rejects a date that is not ISO YYYY-MM-DD or null (capture lets you type anything there)", () => {
    const row = privateRow();
    row.input.evidence.date = "call me at 555-123-4567";
    expect(() => toPublicRow(row)).toThrow(/date/i);
    const ok = privateRow();
    ok.input.evidence.date = null;
    expect(toPublicRow(ok).input.evidence.date).toBeNull();
  });

  it("rejects non-finite or non-numeric money fields", () => {
    const a = privateRow();
    a.input.claim.authorized.budgetUsd = "400";
    expect(() => toPublicRow(a)).toThrow(/budgetUsd/);
    const b = privateRow();
    b.input.evidence.amountUsd = NaN;
    expect(() => toPublicRow(b)).toThrow(/amountUsd/);
  });

  it("rejects an evidence source outside the personal-capture set (ftc/court/press mark incidents, not self-runs)", () => {
    const row = privateRow();
    row.input.evidence.source = "ftc";
    expect(() => toPublicRow(row)).toThrow(/source/);
  });

  it("rejects unknown finding dimensions and severities (enum allowlist, not free text)", () => {
    const a = privateRow();
    a.target.findings = [{ type: "OVERSPEND", dimension: "vibes", severity: "medium" }];
    expect(() => toPublicRow(a)).toThrow(/dimension/);
    const b = privateRow();
    b.target.findings = [{ type: "OVERSPEND", dimension: "money", severity: "catastrophic" }];
    expect(() => toPublicRow(b)).toThrow(/severity/);
  });

  it("rejects an unknown recurringPeriod", () => {
    const row = privateRow();
    row.input.evidence.recurring = true;
    row.input.evidence.recurringPeriod = "sometimes";
    expect(() => toPublicRow(row)).toThrow(/recurringPeriod/);
  });
});

describe("publishCorpus", () => {
  const line = (row) => JSON.stringify(row);

  it("publishes headline-eligible rows and skips the rest with a reason", () => {
    const pasted = privateRow({ id: "cap-002" });
    pasted.meta.provenance = "pasted";
    const out = publishCorpus([line(privateRow()), line(pasted)].join("\n"));
    expect(out.errors).toEqual([]);
    expect(out.rows.map((r) => r.id)).toEqual(["cap-001"]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ id: "cap-002" });
    expect(out.skipped[0].reason).toMatch(/provenance/i);
  });

  it("hard-errors on malformed JSON and on unknown finding types", () => {
    const bad = privateRow();
    bad.target.findings = [{ type: "MADE_UP", dimension: "money", severity: "low" }];
    const out = publishCorpus(["{not json", line(bad)].join("\n"));
    expect(out.rows).toEqual([]);
    expect(out.errors.length).toBe(2);
  });

  it("keeps input order and emits rows that survive a JSONL round-trip", () => {
    const a = privateRow({ id: "cap-001" });
    const b = privateRow({ id: "cap-002" });
    const out = publishCorpus([line(a), line(b)].join("\n"));
    const roundTripped = out.rows.map((r) => JSON.parse(JSON.stringify(r)));
    expect(roundTripped.map((r) => r.id)).toEqual(["cap-001", "cap-002"]);
  });
});
