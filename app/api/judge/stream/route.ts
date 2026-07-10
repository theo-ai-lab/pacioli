/**
 * Pacioli — POST /api/judge/stream. The STREAMED LLM judge, as an HTTP surface.
 *
 * The streaming sibling of the runJudge server action (app/actions/judge.ts): same gating (a key is
 * required; with none it returns {enabled:false} and the UI stays deterministic-only), same bounded
 * input (untrusted client → a paid model, so the prompt is validated and length-capped before the
 * call), same rate limit + daily cost ceiling (lib/ratelimit.ts). It differs only in delivery: it
 * streams the verdict back as newline-delimited JSON (NDJSON) so the UI can render the judge writing
 * token-by-token, then a final line carries the explicit state (match / clean / low-confidence /
 * error) and any badged finding.
 *
 * The judge ITSELF (lib/engine/streaming-judge.ts) is injectable + mock-testable with no key; this
 * route is the thin transport. ── THE LIVE PATH is gated by ANTHROPIC_API_KEY inside the core. ──
 */
import { headers } from "next/headers";
import { z } from "zod";
import { streamJudge, streamingJudgeEnabled } from "@/lib/engine/streaming-judge";
import { checkJudgeRate } from "@/lib/ratelimit";
import { readBodyCapped } from "@/lib/api/auth";
import type { DiffInput } from "@pacioli-app/engine";

// Same bounded contract as the runJudge action — unknown keys stripped, every field length-capped, so
// an oversized prompt can't be used to run up cost / DoS the paid judge.
const InputSchema = z
  .object({
    claim: z
      .object({
        agent: z.string().max(120),
        task: z.string().max(2000),
        text: z.string().max(4000),
        authorized: z
          .object({
            budgetUsd: z.number().nullable().optional(),
            scope: z.string().max(400).optional(),
            constraints: z.array(z.string().max(200)).max(20).optional(),
            mayPurchase: z.boolean().optional(),
            mayRecur: z.boolean().optional(),
          })
          .strip(),
      })
      .strip(),
    evidence: z
      .object({
        source: z.string().max(40),
        merchant: z.string().max(200),
        amountUsd: z.number().nullable(),
        date: z.string().max(40).nullable(),
        items: z.array(z.string().max(300)).max(40),
        recurring: z.boolean(),
        recurringPeriod: z.enum(["weekly", "monthly", "annual"]).optional(),
        excerpt: z.string().max(4000),
      })
      .strip(),
  })
  .strip();

const MAX_BODY_BYTES = 64_000;
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export async function POST(req: Request): Promise<Response> {
  // Gated: with no key the judge can't run — tell the client so it stays deterministic-only.
  if (!streamingJudgeEnabled()) return json({ enabled: false, state: "gated" });

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (text === null) return json({ error: "body too large" }, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = InputSchema.safeParse(parsedJson);
  if (!parsed.success) return json({ enabled: true, error: "invalid input" }, 422);

  // Rate-limit the PAID judge by client IP, with the shared daily cost ceiling.
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "global";
  const rate = checkJudgeRate(ip);
  if (!rate.ok) {
    return json(
      { enabled: true, state: "error", error: rate.reason === "daily" ? "daily-limit" : "rate-limited" },
      429,
    );
  }

  // Abort the model call if the client disconnects; keep an upper-bound timeout regardless.
  const signal =
    typeof req.signal !== "undefined" && req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);

  const handle = streamJudge(parsed.data as DiffInput, { abortSignal: signal });
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0; // length of the rationale already streamed → emit only the new suffix
      try {
        for await (const partial of handle.partialStream) {
          const r = typeof partial.rationale === "string" ? partial.rationale : "";
          if (r.length > sent) {
            controller.enqueue(line({ t: "delta", text: r.slice(sent) }));
            sent = r.length;
          }
        }
        const final = await handle.final();
        controller.enqueue(
          line({
            t: "final",
            state: final.state,
            confidence: final.confidence,
            findings: final.findings,
            error: final.error,
          }),
        );
      } catch (e) {
        // Never surface a fabricated finding on failure — emit an explicit error frame.
        controller.enqueue(line({ t: "error", message: e instanceof Error ? e.message : "stream failed" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no", // disable proxy buffering so tokens flush as they arrive
    },
  });
}
