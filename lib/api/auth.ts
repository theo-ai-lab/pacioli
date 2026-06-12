/**
 * Pacioli — shared-secret check for the API routes.
 *
 * Constant-time comparison: hashing both sides first normalizes lengths so `timingSafeEqual` is
 * usable, and the comparison itself leaks no prefix-match timing. Used by /api/reconcile and
 * /api/metrics so "set PACIOLI_API_KEY" protects the WHOLE API surface, not one route.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** True iff the provided header value matches the required secret (constant-time). */
export function apiKeyMatches(provided: string | null, required: string): boolean {
  if (provided === null) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(required).digest();
  return timingSafeEqual(a, b);
}

/** Read the request body with a HARD byte cap, streaming — a chunked POST carries no content-length,
 *  and `Request.text()` would buffer the entire body before any length check could run. Returns the
 *  decoded text, or null the moment the cap is crossed (caller responds 413). */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
