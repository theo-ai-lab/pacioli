/**
 * Pacioli — GET /api/ledger. The per-user/session receipt ledger (additive product surface).
 *
 * Reads the durable store (lib/store/receipt-store.ts). With `?session=<key>` it returns ONLY the
 * receipts recorded under that session/user key (send the same key on the write routes — /api/reconcile
 * and /api/ingest — via the `x-pacioli-session` header); without it, the shared global ledger — so the
 * endpoint is additive and the un-scoped view keeps working. Honors PACIOLI_API_KEY when configured,
 * exactly like /api/metrics: an operator who sets a key reasonably expects it to cover the whole API surface.
 *
 * Zero new dependencies (Next App Router built-in). Deterministic; no LLM, no key needed.
 */
import { getStore, type StoredReceipt } from "@/lib/store/receipt-store";
import { apiKeyMatches } from "@/lib/api/auth";

const MAX_SESSION_KEY = 200;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Parse + bound the limit param. Missing / NaN / < 1 collapses to the default; large is capped.
 *  (Note: Number(null) and Number("") are 0, so guard those explicitly rather than via isFinite.) */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export async function GET(req: Request): Promise<Response> {
  const required = process.env.PACIOLI_API_KEY;
  if (required && !apiKeyMatches(req.headers.get("x-api-key"), required)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // The session key is untrusted: cap its length and pass it ONLY as a bound query parameter to the
  // store (never interpolated into SQL). An empty/whitespace value reads as "no scope" (global).
  const rawSession = url.searchParams.get("session")?.slice(0, MAX_SESSION_KEY).trim();
  const sessionKey = rawSession || null;
  const limit = parseLimit(url.searchParams.get("limit"));

  // The un-scoped view returns EVERY user's receipts. The product surface promises
  // "scoped to this browser -- nothing is shown that you didn't enter", so serving
  // that view to an unauthenticated caller would contradict the claim. When no key
  // is configured there is nobody who could be authorized for it, so it fails
  // closed rather than defaulting to the widest possible disclosure.
  if (!sessionKey && !required) {
    return Response.json(
      {
        error:
          "the global ledger is operator-only: set PACIOLI_API_KEY and send x-api-key, " +
          "or request a single session with ?session=<key>",
      },
      { status: 403 },
    );
  }

  const store = await getStore();
  const rows: StoredReceipt[] = sessionKey ? store.listBySession(sessionKey, limit) : store.list(limit);
  const stats = sessionKey ? store.statsBySession(sessionKey) : store.stats();
  // sessionKey is the correlation handle for one browser's entire history. A
  // reader who obtains it can re-query that ledger directly, so it never leaves
  // the server -- not even in the scoped view, where the caller already knows it.
  const receipts = rows.map((row) => {
    const rest: Omit<StoredReceipt, "sessionKey"> & { sessionKey?: string } = { ...row };
    delete rest.sessionKey;
    return rest;
  });

  return Response.json(
    {
      scope: sessionKey ? "session" : "global",
      session: sessionKey ?? null,
      backend: store.backend,
      total: stats.total,
      events: stats.events,
      flagged: stats.flagged,
      byType: stats.byType,
      receipts,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
