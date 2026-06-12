import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { GET } from "./route";

const req = (headers: Record<string, string> = {}): Request => new Request("http://test.local/api/metrics", { headers });

const KEY_ORIG = process.env.PACIOLI_API_KEY;
beforeEach(() => delete process.env.PACIOLI_API_KEY);
afterAll(() => {
  if (KEY_ORIG !== undefined) process.env.PACIOLI_API_KEY = KEY_ORIG;
});

describe("GET /api/metrics", () => {
  it("emits valid Prometheus exposition with the full content-type triple", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(text).toMatch(/pacioli_store_info\{backend="(memory|sqlite)"\} 1/);
    expect(text).toContain("# TYPE pacioli_reconciliations_total counter");
    expect(text).toContain("# TYPE pacioli_receipts_unique gauge");
    expect(text).toContain("# TYPE pacioli_receipts_flagged gauge");
  });

  it("honors PACIOLI_API_KEY when configured — the key covers the whole API surface", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req({ "x-api-key": "wrong" }))).status).toBe(401);
    expect((await GET(req({ "x-api-key": "k" }))).status).toBe(200);
  });
});
