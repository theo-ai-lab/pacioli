/**
 * Pacioli — POST /api/reconcile. A minimal, honest HTTP surface over the deterministic engine.
 *
 * Two request shapes share this route:
 *   • SINGLE — `{ task, claim, authorized?, evidence, judge? }` → one verdict + tamper-evident receipt.
 *   • BATCH  — `{ claims: [{ id?, task, claim, authorized? }, …], evidence, judge? }` → a per-claim
 *              supported / unsupported / overclaim verdict against ONE shared body of evidence. This is
 *              the seam a multi-claim caller (e.g. the Career Coach) uses; pick the batch path whenever
 *              the body carries a `claims` array.
 *
 * Zero new dependencies (Next App Router built-in). Optional shared-secret (set PACIOLI_API_KEY to
 * require an `x-api-key` header — constant-time compared). Deterministic by default — no LLM, no key
 * needed; returns a tamper-evident receipt. Validation + engine live in lib/api/reconcile-endpoint.ts
 * so they're unit-tested. CORS-safe for cross-origin browser callers (see lib/api/cors.ts).
 *
 * Honest scope: durable persistence is the zero-dep node:sqlite store (PACIOLI_DB) with an in-memory
 * fallback; judge selection is auth-gated AND rate-limited (lib/ratelimit.ts). For production, add
 * platform/edge rate limiting in front of this route as well.
 */
import { reconcileBatch, reconcileEndpoint } from "@/lib/api/reconcile-endpoint";
import { apiKeyMatches, readBodyCapped } from "@/lib/api/auth";
import { corsHeaders, corsPreflight } from "@/lib/api/cors";
import { checkJudgeRate } from "@/lib/ratelimit";
import { getStore, type StoredReceipt } from "@/lib/store/receipt-store";

/** CORS preflight for cross-origin callers (the Coach in a browser). */
export async function OPTIONS(req: Request): Promise<Response> {
  return corsPreflight(req);
}

export async function POST(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  const json = (body: unknown, status: number, extra?: Record<string, string>): Response =>
    Response.json(body, { status, headers: { ...cors, ...extra } });

  const required = process.env.PACIOLI_API_KEY;
  if (required && !apiKeyMatches(req.headers.get("x-api-key"), required)) {
    return json({ error: "unauthorized" }, 401);
  }

  // Bound the body at the transport layer. The content-length pre-check is the cheap fast path; the
  // streaming read is the real guard — a chunked POST has no content-length, and Request.text()
  // would buffer the whole body before any check. Bytes, not UTF-16 code units. Shared by single and
  // batch: 64KB comfortably fits a typical multi-claim batch (dozens of claims); the schema's 100-claim
  // cap is the real fan-out guard, and a pathological batch of very large claims is rejected here.
  const MAX_BODY_BYTES = 64_000;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ error: "body too large" }, 413);
  }
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (text === null) return json({ error: "body too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  // Judge selection is only honored for AUTHENTICATED callers (PACIOLI_API_KEY configured + matched
  // above), and even then the paid/compute-bound judge goes through the same rate limit + daily cost
  // ceiling as the demo UI — an authenticated key must not be an unbounded spend faucet either. (A
  // batch fans the chosen judge out to one call per claim, so an operator pricing the judge should
  // account for batch size; the per-minute window + daily ceiling are the backstop.)
  const allowJudge = Boolean(required);
  const wantsJudge =
    typeof parsed === "object" && parsed !== null && "judge" in parsed && (parsed as { judge?: unknown }).judge !== "off";
  if (allowJudge && wantsJudge) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "api";
    const rate = checkJudgeRate(ip);
    if (!rate.ok) {
      return json(
        { error: rate.reason === "daily" ? "judge daily cost ceiling reached" : "judge rate-limited" },
        429,
        rate.retryAfterMs ? { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } : undefined,
      );
    }
  }

  const sessionKey = req.headers.get("x-pacioli-session")?.slice(0, 200) || undefined;

  // BATCH path — the body carries a `claims` array.
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { claims?: unknown }).claims)) {
    const res = await reconcileBatch(parsed, { allowJudge });
    if (res.status === 200) {
      // Persist every claim's receipt (best-effort — a store error never fails the response).
      try {
        const store = await getStore();
        for (const c of res.body.claims) {
          store.save({
            receiptId: c.receiptId,
            receiptHash: c.receiptHash,
            balanced: c.balanced,
            findingTypes: [...c.findings, ...c.judgeFindings].map((f) => f.type),
            agent: c.agent,
            merchant: res.body.merchant,
            deltaUsd: c.deltaUsd,
            createdAt: Date.now(),
            sessionKey,
          } satisfies StoredReceipt);
        }
      } catch {
        /* best-effort persistence */
      }
    }
    return json(res.body, res.status);
  }

  // SINGLE path.
  const res = await reconcileEndpoint(parsed, { allowJudge });
  if (res.status === 200) {
    // Persist to the durable store (best-effort — a store error never fails the response).
    // Every field comes from the TYPED success body — no casts of raw input at the storage boundary.
    try {
      (await getStore()).save({
        receiptId: res.body.receiptId,
        receiptHash: res.body.receiptHash,
        balanced: res.body.balanced,
        // Judge-found types are stored too (already badged llmAssisted in the response) so metrics
        // reflect everything the system found; `balanced` stays the deterministic verdict.
        findingTypes: [...res.body.findings, ...res.body.judgeFindings].map((f) => f.type),
        agent: res.body.agent,
        merchant: res.body.merchant,
        deltaUsd: res.body.deltaUsd,
        createdAt: Date.now(),
        // ADDITIVE: optional per-user/session partition, carried in a header so the validated body
        // is untouched. Length-capped; absent header = the shared global ledger (prior behavior).
        sessionKey,
      });
    } catch {
      /* best-effort persistence */
    }
  }

  return json(res.body, res.status);
}
