/**
 * Pacioli — POST /api/reconcile. A minimal, honest HTTP surface over the deterministic engine.
 *
 * Zero new dependencies (Next App Router built-in). Optional shared-secret (set PACIOLI_API_KEY to
 * require an `x-api-key` header — constant-time compared). Deterministic by default — no LLM, no key
 * needed; returns a tamper-evident receipt. Validation + engine live in lib/api/reconcile-endpoint.ts
 * so they're unit-tested.
 *
 * Honest scope: durable persistence is the zero-dep node:sqlite store (PACIOLI_DB) with an in-memory
 * fallback; judge selection is auth-gated AND rate-limited (lib/ratelimit.ts). For production, add
 * platform/edge rate limiting in front of this route as well.
 */
import { reconcileEndpoint } from "@/lib/api/reconcile-endpoint";
import { apiKeyMatches, readBodyCapped } from "@/lib/api/auth";
import { checkJudgeRate } from "@/lib/ratelimit";
import { getStore } from "@/lib/store/receipt-store";

export async function POST(req: Request): Promise<Response> {
  const required = process.env.PACIOLI_API_KEY;
  if (required && !apiKeyMatches(req.headers.get("x-api-key"), required)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Bound the body at the transport layer. The content-length pre-check is the cheap fast path; the
  // streaming read is the real guard — a chunked POST has no content-length, and Request.text()
  // would buffer the whole body before any check. Bytes, not UTF-16 code units.
  const MAX_BODY_BYTES = 64_000;
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

  // Judge selection is only honored for AUTHENTICATED callers (PACIOLI_API_KEY configured + matched
  // above), and even then the paid/compute-bound judge goes through the same rate limit + daily cost
  // ceiling as the demo UI — an authenticated key must not be an unbounded spend faucet either.
  const allowJudge = Boolean(required);
  const wantsJudge =
    typeof json === "object" && json !== null && "judge" in json && (json as { judge?: unknown }).judge !== "off";
  if (allowJudge && wantsJudge) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "api";
    const rate = checkJudgeRate(ip);
    if (!rate.ok) {
      return Response.json(
        { error: rate.reason === "daily" ? "judge daily cost ceiling reached" : "judge rate-limited" },
        { status: 429, headers: rate.retryAfterMs ? { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } : undefined },
      );
    }
  }

  const res = await reconcileEndpoint(json, { allowJudge });

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
      });
    } catch {
      /* best-effort persistence */
    }
  }

  return Response.json(res.body, { status: res.status });
}
