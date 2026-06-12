import { describe, it, expect } from "vitest";
import { apiKeyMatches, readBodyCapped } from "./auth";

describe("apiKeyMatches (constant-time shared-secret check)", () => {
  it("accepts the exact key and rejects everything else", () => {
    expect(apiKeyMatches("s3cret", "s3cret")).toBe(true);
    expect(apiKeyMatches("s3cret-", "s3cret")).toBe(false);
    expect(apiKeyMatches("", "s3cret")).toBe(false);
    expect(apiKeyMatches(null, "s3cret")).toBe(false);
  });
});

const streamOf = (chunks: Uint8Array[]): Request =>
  ({
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    }),
  }) as unknown as Request;

describe("readBodyCapped (streaming byte-counted body guard)", () => {
  it("returns the decoded body when under the cap", async () => {
    const req = streamOf([new TextEncoder().encode('{"a":1}')]);
    expect(await readBodyCapped(req, 64)).toBe('{"a":1}');
  });

  it("aborts with null the moment the byte cap is crossed (chunked body, no content-length)", async () => {
    // 3 chunks of 30KB — the guard must bail during streaming, never buffer the whole body.
    const chunk = new Uint8Array(30_000).fill(120); // 'x'
    const req = streamOf([chunk, chunk, chunk]);
    expect(await readBodyCapped(req, 64_000)).toBeNull();
  });

  it("counts BYTES, not UTF-16 code units", async () => {
    // 4-byte emoji × 20 = 80 bytes but only 40 UTF-16 code units — must still trip a 64-byte cap.
    const req = streamOf([new TextEncoder().encode("💸".repeat(20))]);
    expect(await readBodyCapped(req, 64)).toBeNull();
  });

  it("treats a missing body as empty", async () => {
    expect(await readBodyCapped({ body: null } as unknown as Request, 64)).toBe("");
  });
});
