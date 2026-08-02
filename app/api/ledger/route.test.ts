import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createMemoryStore, type ReceiptStore, type StoredReceipt } from "@/lib/store/receipt-store";

// In-memory store under our control — the route reads it via getStore().
const h = vi.hoisted(() => ({ store: null as ReceiptStore | null }));
vi.mock("@/lib/store/receipt-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/receipt-store")>();
  return { ...actual, getStore: async () => h.store };
});

import { GET } from "./route";

const URL_ = "http://test.local/api/ledger";
const mk = (id: string, balanced: boolean, types: string[], sessionKey?: string, createdAt = 1): StoredReceipt => ({
  receiptId: id,
  receiptHash: "h" + id,
  balanced,
  findingTypes: types,
  agent: "a",
  merchant: "m",
  deltaUsd: null,
  createdAt,
  sessionKey,
});

const get = (qs = "", headers: Record<string, string> = {}): Promise<Response> =>
  GET(new Request(URL_ + qs, { headers }));

const KEY_ORIG = process.env.PACIOLI_API_KEY;
beforeEach(async () => {
  delete process.env.PACIOLI_API_KEY;
  const s = createMemoryStore();
  await s.save(mk("a1", false, ["OVERSPEND"], "user-alice", 1));
  await s.save(mk("a2", true, [], "user-alice", 2));
  await s.save(mk("b1", false, ["SCOPE_CREEP"], "user-bob", 3));
  await s.save(mk("g1", true, [])); // global-only
  h.store = s;
});
afterAll(() => {
  if (KEY_ORIG !== undefined) process.env.PACIOLI_API_KEY = KEY_ORIG;
});

interface LedgerBody {
  scope: string;
  session: string | null;
  backend: string;
  total: number;
  flagged: number;
  byType: Record<string, number>;
  receipts: StoredReceipt[];
}

describe("GET /api/ledger — per-user/session ledger", () => {
  it("scopes to one session and never leaks another user's receipts", async () => {
    const res = await get("?session=user-alice");
    expect(res.status).toBe(200);
    const b = (await res.json()) as LedgerBody;
    expect(b.scope).toBe("session");
    expect(b.session).toBe("user-alice");
    expect(b.total).toBe(2);
    expect(b.flagged).toBe(1);
    expect(b.receipts.map((r) => r.receiptId)).toEqual(["a2", "a1"]); // newest first
    // Bob's receipt and the global-only one are absent. Asserted on ids rather
    // than on a returned sessionKey, because the response no longer carries one.
    expect(b.receipts.map((r) => r.receiptId)).not.toContain("b1");
    expect(b.receipts.map((r) => r.receiptId)).not.toContain("g1");
  });

  it("REFUSES the un-scoped global ledger when no API key is configured", async () => {
    // The un-scoped view returns every user's receipts. Serving that to an
    // unauthenticated caller contradicts "scoped to this browser -- nothing is
    // shown that you didn't enter", which the product surface promises. With no
    // key configured there is no one to authorize it, so it fails closed.
    const res = await get();
    expect(res.status).toBe(403);
    const b = (await res.json()) as { error: string };
    expect(b.error).toMatch(/global/i);
  });

  it("serves the global ledger to an operator holding the configured key", async () => {
    process.env.PACIOLI_API_KEY = "k";
    const res = await get("", { "x-api-key": "k" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LedgerBody;
    expect(body.scope).toBe("global");
    expect(body.total).toBe(4);
  });

  it("never returns a session key to anyone, in either scope", async () => {
    // sessionKey is the correlation handle for one browser's whole history.
    // Returning it lets any reader enumerate and re-query another user's ledger,
    // so it must not leave the server in either scope.
    const scoped = (await (await get("?session=user-alice")).json()) as LedgerBody;
    expect(scoped.receipts.length).toBe(2);
    expect(scoped.receipts.some((r) => r.sessionKey !== undefined)).toBe(false);

    process.env.PACIOLI_API_KEY = "k";
    const global_ = (await (await get("", { "x-api-key": "k" })).json()) as LedgerBody;
    expect(global_.receipts.length).toBe(4);
    expect(global_.receipts.some((r) => r.sessionKey !== undefined)).toBe(false);
  });

  it("an unknown session is empty, not an error", async () => {
    const b = (await (await get("?session=nobody")).json()) as LedgerBody;
    expect(b.total).toBe(0);
    expect(b.receipts).toEqual([]);
  });

  it("honors PACIOLI_API_KEY like the rest of the API surface", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await get("?session=user-alice")).status).toBe(401);
    expect((await get("?session=user-alice", { "x-api-key": "wrong" })).status).toBe(401);
    expect((await get("?session=user-alice", { "x-api-key": "k" })).status).toBe(200);
  });

  it("bounds the limit param (out-of-range collapses, does not throw)", async () => {
    const b = (await (await get("?session=user-alice&limit=-5")).json()) as LedgerBody;
    expect(b.total).toBe(2); // still returns; limit normalized
  });
});
