/**
 * Pacioli — the /api/reconcile endpoint logic (transport-free, so it's unit-testable).
 *
 * Validates an untrusted, BOUNDED JSON body (cost/DoS guard), runs the deterministic engine, and
 * returns a status + a tamper-evident receipt. The thin Next route (app/api/reconcile/route.ts) only
 * adds the optional shared-secret check and wires Request/Response around this.
 */
import { z } from "zod";
import { buildReceipt } from "../engine/receipt";
import { resolveJudge } from "../engine/judge-router";
import type { DiffInput, Finding } from "../engine/types";

export const ReconcileBody = z.object({
  agent: z.string().max(120).default("api"),
  task: z.string().max(2000),
  claim: z.string().max(4000),
  authorized: z
    .object({
      budgetUsd: z.number().nullable().optional(),
      scope: z.string().max(400).optional(),
      constraints: z.array(z.string().max(200)).max(20).optional(),
      mayPurchase: z.boolean().optional(),
      mayRecur: z.boolean().optional(),
    })
    .default({}),
  evidence: z.object({
    merchant: z.string().max(200),
    amountUsd: z.number().nullable().optional(),
    date: z.string().max(40).nullable().optional(),
    items: z.array(z.string().max(200)).max(50).default([]),
    recurring: z.boolean().default(false),
    recurringPeriod: z.enum(["weekly", "monthly", "annual"]).optional(),
    excerpt: z.string().max(1000).default(""),
  }),
  judge: z.enum(["auto", "local", "anthropic", "off"]).default("off"),
});

/** Every value judgeMode can take on the wire — a closed union so consumers can switch exhaustively.
 *  "unauthorized" = judge requested without auth; "unavailable" = requested backend can't run (no
 *  Ollama / no key) — distinct from "ran and found nothing"; "error" = the judge call failed (the
 *  deterministic verdict is still returned in full). */
export type ReturnedJudgeMode = "off" | "unauthorized" | "unavailable" | "error" | "local" | "anthropic";

/** The success body — typed end-to-end so the route can't silently persist a renamed/dropped field. */
export interface ReconcileSuccess {
  agent: string;
  merchant: string;
  balanced: boolean;
  findings: Finding[];
  /** null (not omitted) when no amount was computable — one stable absence convention. */
  deltaUsd: number | null;
  likelyCause: string | null;
  receiptId: string;
  receiptHash: string;
  judgeMode: ReturnedJudgeMode;
  judgeFindings: Finding[];
}

export type EndpointResponse =
  | { status: 200; body: ReconcileSuccess }
  | { status: 422; body: { error: string; issues: unknown } };

export async function reconcileEndpoint(json: unknown, opts?: { allowJudge?: boolean }): Promise<EndpointResponse> {
  const parsed = ReconcileBody.safeParse(json);
  if (!parsed.success) return { status: 422, body: { error: "invalid body", issues: parsed.error.issues } };
  const b = parsed.data;

  const input: DiffInput = {
    claim: { agent: b.agent, task: b.task, text: b.claim, authorized: b.authorized },
    evidence: {
      source: "pasted",
      merchant: b.evidence.merchant,
      amountUsd: b.evidence.amountUsd ?? null,
      date: b.evidence.date ?? null,
      items: b.evidence.items,
      recurring: b.evidence.recurring,
      recurringPeriod: b.evidence.recurringPeriod,
      excerpt: b.evidence.excerpt,
    },
  };

  const r = await buildReceipt(input);

  // Optional selectable judge for the abstained CLAIM_MISMATCH residual (default off = deterministic).
  // The hashed receipt stays the DETERMINISTIC verdict (reproducible); judge findings are returned
  // separately and badged llmAssisted — an LLM never silently changes the tamper-evident receipt.
  // AUTH-GATED: a judge call spends money (hosted) or compute (local Ollama), so the caller must be
  // authenticated (opts.allowJudge) — otherwise an open deployment is an anonymous spend faucet.
  // HONESTY: a requested-but-unrunnable judge reports "unavailable", and a failed judge call reports
  // "error" — never the silent empty-findings shape that reads as "ran and found nothing".
  let judgeMode: ReturnedJudgeMode = "off";
  let judgeFindings: Finding[] = [];
  if (b.judge !== "off") {
    if (!opts?.allowJudge) {
      judgeMode = "unauthorized"; // deterministic verdict still returned in full
    } else {
      const resolved = await resolveJudge(b.judge);
      if (!resolved.available) {
        // "auto" degrading to deterministic is the documented contract ("off"); an EXPLICIT backend
        // that can't run is a distinct, named condition.
        judgeMode = resolved.mode === "off" ? "off" : "unavailable";
      } else {
        judgeMode = resolved.mode;
        try {
          judgeFindings = await resolved.judge(input);
        } catch {
          judgeMode = "error"; // judge failed (timeout/5xx) — keep the 200 deterministic verdict
          judgeFindings = [];
        }
      }
    }
  }

  return {
    status: 200,
    body: {
      agent: b.agent,
      merchant: b.evidence.merchant,
      balanced: r.verdict.balanced,
      findings: r.verdict.findings,
      deltaUsd: r.verdict.deltaUsd ?? null,
      likelyCause: r.likelyCause,
      receiptId: r.receiptId,
      receiptHash: r.receiptHash,
      judgeMode,
      judgeFindings,
    },
  };
}
