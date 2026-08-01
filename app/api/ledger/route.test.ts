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
    expect(b.receipts.every((r) => r.sessionKey === "user-alice")).toBe(true);
  });

  it("returns the global ledger when no session is given (additive — un-scoped still works)", async () => {
    const b = (await get()).json() as Promise<LedgerBody>;
    const body = await b;
    expect(body.scope).toBe("global");
    expect(body.total).toBe(4);
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
