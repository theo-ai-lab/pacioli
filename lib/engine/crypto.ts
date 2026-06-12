/**
 * Pacioli — shared crypto primitives (zero dependencies; Web Crypto, Node 20+ & all browsers).
 * Used by receipt-hash (content addressing) and merkle (tamper-evident audit log).
 */

/** Stable, sorted-key serialization so a hash is canonical (key order can't change it). */
export function canonicalJSON(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return "[" + x.map(canonicalJSON).join(",") + "]";
  const o = x as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(o[k])).join(",") + "}";
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
