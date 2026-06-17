import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createMemoryStore, type ReceiptStore } from "@/lib/store/receipt-store";

// In-memory store under our control — the route writes to it via getStore(). Mocking the store is the
// only seam needed: extraction + reconcile are pure/in-process, so the route runs fully offline (no
// Gmail MCP, no network). Fixture confirmation payloads stand in for a forwarded email.
const h = vi.hoisted(() => ({ store: null as ReceiptStore | null }));
vi.mock("@/lib/store/receipt-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/receipt-store")>();
  return { ...actual, getStore: async () => h.store };
});

import { POST } from "./route";

const URL_ = "http://test.local/api/ingest";

// ── Fixtures: forwarded merchant confirmations (email-shaped, NOT pre-extracted evidence) ──────────

/** Clean match: a flight booked within the authorized $300 budget. Total is below the ceiling. */
const cleanMatch = {
  task: "book one nonstop flight under $300",
  claim: "Booked a nonstop on United for $282.40, within your budget.",
  authorized: { budgetUsd: 300, mayPurchase: true, scope: "book one flight" },
  confirmation: {
    from: "United Airlines <receipts@united.com>",
    subject: "Your receipt for confirmation ABC123",
    body: [
      "Thanks for booking with United.",
      "Flight UA482  SFO -> JFK  nonstop",
      "Fare           $254.40",
      "Taxes & fees    $28.00",
      "Total charged: $282.40",
    ].join("\n"),
    receivedAt: "2026-06-14",
  },
};

/** Overspend: the same authorization, but the confirmation shows a charge far over budget. */
const overspend = {
  task: "book one nonstop flight under $300",
  claim: "Booked your flight within budget.",
  authorized: { budgetUsd: 300, mayPurchase: true, scope: "book one flight" },
  confirmation: {
    from: "Delta <no-reply@delta.com>",
    subject: "Your trip is confirmed",
    body: ["Itinerary: ATL -> LHR", "Subtotal  $760.00", "Taxes      $52.00", "Amount charged: $812.00"].join("\n"),
    receivedAt: "2026-06-14",
  },
};

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  POST(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

interface IngestResBody {
  merchant: string;
  balanced: boolean;
  deltaUsd: number | null;
  source: string;
  findings: Array<{ type: string }>;
  receiptId: string;
  evidence: { merchant: string; amountUsd: number | null; source: string; excerpt: string };
}

const KEY_ORIG = process.env.PACIOLI_API_KEY;
beforeEach(() => {
  delete process.env.PACIOLI_API_KEY;
  h.store = createMemoryStore();
});
afterAll(() => {
  if (KEY_ORIG !== undefined) process.env.PACIOLI_API_KEY = KEY_ORIG;
});

describe("POST /api/ingest — forwarded-confirmation ingestion into the per-user ledger", () => {
  it("extracts evidence from a clean confirmation, balances it, and writes to the session ledger", async () => {
    const res = await post(cleanMatch, { "x-pacioli-session": "user-alice" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as IngestResBody;

    // extraction read the right fields out of the unstructured email
    expect(b.source).toBe("email");
    expect(b.merchant).toBe("United Airlines"); // from the display name
    expect(b.evidence.amountUsd).toBe(282.4); // the labeled "Total charged", not a component line
    expect(b.evidence.source).toBe("email");

    // reconcile: 282.40 is within the $300 budget → balanced, no findings
    expect(b.balanced).toBe(true);
    expect(b.findings).toEqual([]);
    expect(b.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);

    // persisted to alice's ledger
    const alice = h.store!.listBySession("user-alice");
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({ receiptId: b.receiptId, merchant: "United Airlines", balanced: true, sessionKey: "user-alice" });
  });

  it("flags an overspend confirmation (engine catches the charge over budget) and stores it flagged", async () => {
    const res = await post(overspend, { "x-pacioli-session": "user-bob" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as IngestResBody;

    expect(b.evidence.amountUsd).toBe(812); // "Amount charged", not the $760 subtotal
    expect(b.balanced).toBe(false);
    expect(b.findings.map((f) => f.type)).toContain("OVERSPEND");
    expect(b.deltaUsd).toBe(512); // 812 - 300

    const bob = h.store!.statsBySession("user-bob");
    expect(bob).toMatchObject({ total: 1, flagged: 1 });
    expect(bob.byType.OVERSPEND).toBe(1);
  });

  it("isolates ledgers by session — neither user sees the other's receipt", async () => {
    await post(cleanMatch, { "x-pacioli-session": "user-alice" });
    await post(overspend, { "x-pacioli-session": "user-bob" });

    const alice = h.store!.listBySession("user-alice");
    const bob = h.store!.listBySession("user-bob");
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0].balanced).toBe(true); // alice only sees her clean receipt
    expect(bob[0].balanced).toBe(false); // bob only sees his flagged one
    expect(alice[0].receiptId).not.toBe(bob[0].receiptId);

    // an unknown session is empty, never a leak; the global view still sees both (additive)
    expect(h.store!.listBySession("nobody")).toEqual([]);
    expect(h.store!.stats().total).toBe(2);
  });

  it("writes to the global ledger when no session header is sent (additive — un-scoped still works)", async () => {
    const res = await post(cleanMatch);
    expect(res.status).toBe(200);
    expect(h.store!.stats().total).toBe(1);
    expect(h.store!.list()[0].sessionKey).toBeUndefined();
  });

  it("redacts the excerpt and never persists the raw body (privacy invariant)", async () => {
    const res = await post(cleanMatch, { "x-pacioli-session": "user-alice" });
    const b = (await res.json()) as IngestResBody;
    expect(b.evidence.excerpt).not.toContain("receipts@united.com"); // email masked
    expect(b.evidence.excerpt.length).toBeLessThanOrEqual(280);
    // the stored row carries no body field at all — only extracted/derived columns
    expect(Object.keys(h.store!.listBySession("user-alice")[0])).not.toContain("body");
  });

  it("422s a shape-invalid payload (missing confirmation body) and writes nothing", async () => {
    const res = await post({ task: "t", claim: "c", confirmation: { subject: "no body" } });
    expect(res.status).toBe(422);
    expect(h.store!.stats().total).toBe(0);
  });

  it("honors PACIOLI_API_KEY like the rest of the API surface", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await post(cleanMatch)).status).toBe(401);
    expect((await post(cleanMatch, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await post(cleanMatch, { "x-api-key": "k", "x-pacioli-session": "user-alice" })).status).toBe(200);
  });
});
