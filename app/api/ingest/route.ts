/**
 * Pacioli — POST /api/ingest. REAL INGESTION: a forwarded merchant confirmation reconciles into the
 * caller's per-user ledger (a real external system feeding the books, not a paste-in demo).
 *
 * The body is an email-shaped payload ({ confirmation: { from, subject, body, receivedAt }, task,
 * claim, authorized }). This route only does transport (auth + body cap + session header + persist);
 * extraction + reconcile live in lib/api/ingest-endpoint.ts so they're unit-tested with fixtures and
 * have ZERO external dependency. The receipt is written to the session ledger keyed by the
 * `x-pacioli-session` header — readable back via GET /api/ledger?session=<key>.
 *
 * Zero new dependencies (Next App Router built-in). Honors PACIOLI_API_KEY like the rest of the API
 * surface. Deterministic — no LLM on this path, so no key is required to use it.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WIRING A REAL INGESTION SOURCE (the email-fetching lives OUTSIDE this route — that's why the route
 * stays offline-testable; this endpoint is the transport-agnostic sink both sources POST into):
 *
 *  A) Gmail poller/worker — the Gmail API or any Gmail MCP server (cron or an agent loop), NOT this request path:
 *       1. search recent threads, e.g. q: "newer_than:1d (receipt OR confirmation OR order OR invoice)"
 *       2. fetch each thread → take the latest message; decode its text/plain
 *          part to a plain-text `body` (strip HTML if only text/html exists).
 *       3. POST here as the user:
 *            fetch("/api/ingest", {
 *              method: "POST",
 *              headers: { "content-type": "application/json", "x-pacioli-session": userKey },
 *              body: JSON.stringify({
 *                task, claim, authorized,                        // the run being audited (from your app)
 *                confirmation: { from: msg.from, subject: msg.subject, body, receivedAt: msg.date },
 *              }),
 *            })
 *     The fetch is deliberately kept out of this file: the route has no Gmail dependency and the
 *     tests never need it live. Label processed threads for idempotency.
 *
 *  B) Mail-provider inbound webhook — SendGrid Inbound Parse / Mailgun Routes / Postmark inbound:
 *       - Forward receipts to a parse address; the provider POSTs the parsed email to your webhook.
 *       - VERIFY the provider signature first (do not trust an unauthenticated inbound POST), resolve
 *         the user from the envelope/plus-address, then map { from, subject, text, date } → the same
 *         confirmation payload above and POST it here (server-to-server) with that user's session key.
 *
 * Either way the contract is identical, so swapping or running both sources needs no change here.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { ingestEndpoint } from "@/lib/api/ingest-endpoint";
import { apiKeyMatches, readBodyCapped } from "@/lib/api/auth";
import { getStore } from "@/lib/store/receipt-store";

export async function POST(req: Request): Promise<Response> {
  const required = process.env.PACIOLI_API_KEY;
  if (required && !apiKeyMatches(req.headers.get("x-api-key"), required)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Bound the body at the transport layer (a confirmation body can be larger than a /reconcile call).
  // Content-length is the cheap pre-check; the streaming read is the real guard (a chunked POST has no
  // content-length, and Request.text() would buffer it all first). Bytes, not UTF-16 code units.
  const MAX_BODY_BYTES = 128_000;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (text === null) return Response.json({ error: "body too large" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const res = await ingestEndpoint(json);

  if (res.status === 200) {
    // Persist to the durable store, scoped to this user's session ledger (best-effort — a store error
    // never fails the response). Every field comes from the TYPED success body; the raw confirmation
    // body is NOT among them (PRIVACY INVARIANT — only extracted fields persist).
    try {
      (await getStore()).save({
        receiptId: res.body.receiptId,
        receiptHash: res.body.receiptHash,
        balanced: res.body.balanced,
        findingTypes: res.body.findings.map((f) => f.type),
        agent: res.body.agent,
        merchant: res.body.merchant,
        deltaUsd: res.body.deltaUsd,
        createdAt: Date.now(),
        // ADDITIVE: per-user partition, carried in a header so the validated body is untouched.
        // Length-capped; absent header = the shared global ledger (same convention as /api/reconcile).
        sessionKey: req.headers.get("x-pacioli-session")?.slice(0, 200) || undefined,
      });
    } catch {
      /* best-effort persistence */
    }
  }

  return Response.json(res.body, { status: res.status });
}
