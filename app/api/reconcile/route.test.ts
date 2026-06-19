import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { __resetRateLimit } from "@/lib/ratelimit";

// HERMETIC: never let a route test reach a real Ollama or the Anthropic API.
vi.mock("@/lib/engine/local-judge", () => ({
  localJudgeAvailable: async () => false,
  localJudge: async () => [],
  fence: (s: string, max = 600) => s.replace(/[<>]/g, " ").slice(0, max),
}));

import { OPTIONS, POST } from "./route";

const URL_ = "http://test.local/api/reconcile";
const valid = {
  task: "book under $300",
  claim: "booked within budget",
  authorized: { budgetUsd: 300, mayPurchase: true },
  evidence: { merchant: "United", amountUsd: 378 },
};
const post = (body: BodyInit, headers: Record<string, string> = {}): Promise<Response> =>
  POST(new Request(URL_, { method: "POST", body, headers }));

const KEY_ORIG = process.env.PACIOLI_API_KEY;
const ANTHROPIC_ORIG = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  delete process.env.PACIOLI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  __resetRateLimit();
});
afterAll(() => {
  if (KEY_ORIG !== undefined) process.env.PACIOLI_API_KEY = KEY_ORIG;
  if (ANTHROPIC_ORIG !== undefined) process.env.ANTHROPIC_API_KEY = ANTHROPIC_ORIG;
});

describe("POST /api/reconcile — transport security behaviors", () => {
  it("401s when a key is configured and the header is wrong or missing", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await post(JSON.stringify(valid))).status).toBe(401);
    expect((await post(JSON.stringify(valid), { "x-api-key": "wrong" })).status).toBe(401);
  });

  it("200s with the right key, and openly without one", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await post(JSON.stringify(valid), { "x-api-key": "k" })).status).toBe(200);
    delete process.env.PACIOLI_API_KEY;
    const res = await post(JSON.stringify(valid));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { receiptId: string; agent: string; merchant: string; balanced: boolean };
    expect(b.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(b.merchant).toBe("United");
    expect(b.balanced).toBe(false); // 378 > 300
  });

  it("413s an oversized body (the DoS guard)", async () => {
    expect((await post("x".repeat(70_000))).status).toBe(413);
  });

  it("400s malformed JSON and 422s a shape-invalid body", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post(JSON.stringify({ nope: true }))).status).toBe(422);
  });

  it("refuses judge selection for unauthenticated callers (judgeMode 'unauthorized')", async () => {
    const res = await post(JSON.stringify({ ...valid, judge: "local" }));
    const b = (await res.json()) as { judgeMode: string; judgeFindings: unknown[] };
    expect(b.judgeMode).toBe("unauthorized");
    expect(b.judgeFindings).toEqual([]);
  });

  it("names an unrunnable judge 'unavailable' for authenticated callers", async () => {
    process.env.PACIOLI_API_KEY = "k";
    const res = await post(JSON.stringify({ ...valid, judge: "local" }), { "x-api-key": "k" });
    const b = (await res.json()) as { judgeMode: string };
    expect(b.judgeMode).toBe("unavailable"); // Ollama mocked away — must not read as "ran clean"
  });

  it("rate-limits authenticated judge calls (429 past the per-minute window)", async () => {
    process.env.PACIOLI_API_KEY = "k";
    const h = { "x-api-key": "k", "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 5; i++) {
      expect((await post(JSON.stringify({ ...valid, judge: "local" }), h)).status).toBe(200);
    }
    const sixth = await post(JSON.stringify({ ...valid, judge: "local" }), h);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /api/reconcile — CORS (cross-origin browser callers, e.g. the Coach)", () => {
  it("answers the preflight with 204 + allow-* headers", async () => {
    const res = await OPTIONS(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://coach.example" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*"); // open by default (no credentials)
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-api-key");
  });

  it("echoes the allow-origin header on the POST response too", async () => {
    const res = await post(JSON.stringify(valid));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("honors a PACIOLI_CORS_ORIGIN allowlist (matching origin echoed, with Vary)", async () => {
    process.env.PACIOLI_CORS_ORIGIN = "https://coach.example,https://app.example";
    try {
      const res = await OPTIONS(
        new Request(URL_, { method: "OPTIONS", headers: { origin: "https://app.example" } }),
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
      expect(res.headers.get("vary")).toBe("Origin");
      const denied = await OPTIONS(
        new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      );
      // A non-allowlisted origin gets the first configured origin, never the attacker's.
      expect(denied.headers.get("access-control-allow-origin")).toBe("https://coach.example");
    } finally {
      delete process.env.PACIOLI_CORS_ORIGIN;
    }
  });
});

describe("POST /api/reconcile — batch (claims array)", () => {
  const batch = {
    claims: [
      { id: "tight", task: "book under $300", claim: "booked", authorized: { budgetUsd: 300, mayPurchase: true } },
      { id: "loose", task: "book under $500", claim: "booked", authorized: { budgetUsd: 500, mayPurchase: true } },
    ],
    evidence: { merchant: "United", amountUsd: 378 },
  };

  it("returns a per-claim supported/overclaim verdict + summary, and persists each receipt", async () => {
    const res = await post(JSON.stringify(batch), { "x-pacioli-session": "sess-batch-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const b = (await res.json()) as {
      merchant: string;
      judgeMode: string;
      claims: Array<{ id: string; status: string; balanced: boolean; receiptId: string }>;
      summary: { total: number; supported: number; unsupported: number; overclaim: number };
    };
    expect(b.merchant).toBe("United");
    expect(b.claims.map((c) => c.id)).toEqual(["tight", "loose"]);
    expect(b.claims.find((c) => c.id === "tight")?.status).toBe("overclaim");
    expect(b.claims.find((c) => c.id === "loose")?.status).toBe("supported");
    expect(b.summary).toEqual({ total: 2, supported: 1, unsupported: 0, overclaim: 1 });

    // The per-claim receipts landed in the session ledger.
    const { GET } = await import("../ledger/route");
    const ledger = await GET(new Request("http://test.local/api/ledger?session=sess-batch-1"));
    const lj = (await ledger.json()) as { total: number; receipts: Array<{ receiptId: string }> };
    expect(lj.total).toBe(2);
  });

  it("422s a batch with an empty claims array", async () => {
    expect((await post(JSON.stringify({ claims: [], evidence: { merchant: "U" } }))).status).toBe(422);
  });

  it("refuses judge selection for unauthenticated batch callers (judgeMode 'unauthorized')", async () => {
    const res = await post(JSON.stringify({ ...batch, judge: "local" }));
    const b = (await res.json()) as { judgeMode: string };
    expect(b.judgeMode).toBe("unauthorized");
  });
});
