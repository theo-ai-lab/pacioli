/**
 * Pacioli — the caller must be able to tell whether the receipt actually landed in the ledger.
 *
 * This product's pitch is that the ledger IS the record. A 200 carrying a receiptId for a receipt
 * that was never persisted is the one failure mode that quietly falsifies the pitch: the caller
 * files the id, the ledger doesn't have it, and nothing anywhere said so. Both write paths (single
 * and batch) must report the persistence outcome, not swallow it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// HERMETIC: never let a route test reach a real Ollama or the Anthropic API.
vi.mock("@/lib/engine/local-judge", () => ({
  localJudgeAvailable: async () => false,
  localJudge: async () => [],
  fence: (s: string, max = 600) => s.replace(/[<>]/g, " ").slice(0, max),
}));

// A store under our control — the route reaches it through getStore().
const h: { store: ReceiptStore } = { store: null as unknown as ReceiptStore };
vi.mock("@/lib/store/receipt-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/receipt-store")>();
  return { ...actual, getStore: async () => h.store };
});

import { createMemoryStore, type ReceiptStore } from "@/lib/store/receipt-store";
import { POST } from "./route";

/** A store whose durable write fails — a full disk, a read-only volume, a dead DB file. */
const brokenStore = (): ReceiptStore => ({
  ...createMemoryStore(),
  save: async () => {
    throw new Error("disk full");
  },
});

const URL_ = "http://test.local/api/reconcile";
const post = (body: unknown): Promise<Response> =>
  POST(new Request(URL_, { method: "POST", body: JSON.stringify(body), headers: { "x-pacioli-session": "user-alice" } }));

const single = {
  task: "book under $300",
  claim: "booked within budget",
  authorized: { budgetUsd: 300, mayPurchase: true },
  evidence: { merchant: "United", amountUsd: 378 },
};
const batch = {
  claims: [
    { id: "c1", task: "book under $300", claim: "booked within budget", authorized: { budgetUsd: 300, mayPurchase: true } },
    { id: "c2", task: "no extras", claim: "no extras purchased", authorized: { budgetUsd: 300, mayPurchase: true } },
  ],
  evidence: { merchant: "United", amountUsd: 378 },
};

beforeEach(() => {
  delete process.env.PACIOLI_API_KEY;
  h.store = createMemoryStore();
});

describe("POST /api/reconcile — the persistence outcome is reported, never swallowed", () => {
  it("SINGLE: says stored:true when the receipt reached the ledger", async () => {
    const res = await post(single);
    const body = (await res.json()) as { receiptId: string; stored: boolean };
    expect(res.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(h.store.get(body.receiptId)).not.toBeNull();
  });

  it("SINGLE: says stored:false when the write failed — the caller is not told a lie", async () => {
    h.store = brokenStore();
    const res = await post(single);
    const body = (await res.json()) as { receiptId: string; stored: boolean };
    expect(res.status).toBe(200);
    expect(body.receiptId).toMatch(/^sha256:/); // the verdict still stands…
    expect(body.stored).toBe(false); // …but the ledger does NOT have it, and it says so
  });

  it("BATCH: says stored:true when every claim's receipt reached the ledger", async () => {
    const res = await post(batch);
    const body = (await res.json()) as { claims: { receiptId: string }[]; stored: boolean };
    expect(res.status).toBe(200);
    expect(body.stored).toBe(true);
    for (const c of body.claims) expect(h.store.get(c.receiptId)).not.toBeNull();
  });

  it("BATCH: says stored:false when the write failed", async () => {
    h.store = brokenStore();
    const res = await post(batch);
    const body = (await res.json()) as { claims: unknown[]; stored: boolean };
    expect(res.status).toBe(200);
    expect(body.claims).toHaveLength(2);
    expect(body.stored).toBe(false);
  });

  it("BATCH: a PARTIAL write is stored:false — 'some of them' is not 'stored'", async () => {
    const mem = createMemoryStore();
    let n = 0;
    h.store = {
      ...mem,
      save: async (r) => {
        if (n++ === 1) throw new Error("disk full");
        await mem.save(r);
      },
    };
    const res = await post(batch);
    const body = (await res.json()) as { stored: boolean };
    expect(body.stored).toBe(false);
  });
});
