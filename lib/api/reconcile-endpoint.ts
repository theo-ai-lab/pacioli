/**
 * Pacioli — the /api/reconcile endpoint logic (transport-free, so it's unit-testable).
 *
 * Validates an untrusted, BOUNDED JSON body (cost/DoS guard), runs the deterministic engine, and
 * returns a status + a tamper-evident receipt. The thin Next route (app/api/reconcile/route.ts) only
 * adds the optional shared-secret check and wires Request/Response around this.
 */
import { z } from "zod";
import { buildReceipt } from "../engine/receipt";
import { resolveJudge, type JudgeMode } from "../engine/judge-router";
import type { DiffInput, Finding, FindingType } from "../engine/types";

// Shared sub-schemas — the single-claim and the batch (claims-array) bodies reuse the SAME
// authorization + evidence shapes so the two surfaces can never drift.
const AuthorizedSchema = z
  .object({
    budgetUsd: z.number().nullable().optional(),
    scope: z.string().max(400).optional(),
    constraints: z.array(z.string().max(200)).max(20).optional(),
    mayPurchase: z.boolean().optional(),
    mayRecur: z.boolean().optional(),
  })
  .default({});

const EvidenceSchema = z.object({
  merchant: z.string().max(200),
  amountUsd: z.number().nullable().optional(),
  date: z.string().max(40).nullable().optional(),
  items: z.array(z.string().max(200)).max(50).default([]),
  recurring: z.boolean().default(false),
  recurringPeriod: z.enum(["weekly", "monthly", "annual"]).optional(),
  excerpt: z.string().max(1000).default(""),
});

const JudgeSchema = z.enum(["auto", "local", "anthropic", "off"]).default("off");

export const ReconcileBody = z.object({
  agent: z.string().max(120).default("api"),
  task: z.string().max(2000),
  claim: z.string().max(4000),
  authorized: AuthorizedSchema,
  evidence: EvidenceSchema,
  judge: JudgeSchema,
});

/** One claim in a BATCH request: the same per-claim fields as the single body, minus the shared
 *  evidence + judge selector (those are declared once at the top level and held against every claim). */
const ClaimEntry = z.object({
  /** Caller-supplied stable id, echoed back so the Coach can map a verdict to its source claim. */
  id: z.string().max(120).optional(),
  agent: z.string().max(120).default("api"),
  task: z.string().max(2000),
  claim: z.string().max(4000),
  authorized: AuthorizedSchema,
});

/** The BATCH body — N claims reconciled against ONE shared body of evidence. This is the seam a
 *  multi-claim caller (e.g. the Career Coach grading a set of résumé claims against one evidence
 *  packet) uses; each claim gets its own deterministic verdict + receipt. */
export const ReconcileBatchBody = z.object({
  claims: z.array(ClaimEntry).min(1).max(100),
  evidence: EvidenceSchema,
  judge: JudgeSchema,
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

// ── Judge resolution (shared by the single + batch endpoints) ───────────────────────────────────────
//
// The optional judge handles ONLY the abstained CLAIM_MISMATCH residual; the deterministic verdict +
// tamper-evident receipt are always returned in full regardless of the judge. AUTH-GATED: a judge call
// spends money (hosted) or compute (local Ollama), so the caller must be authenticated (allowJudge) —
// otherwise an open deployment is an anonymous spend faucet. The judge is resolved ONCE here so a batch
// pays a single availability probe and reuses the same backend across every claim.
interface JudgePlan {
  /** A terminal mode known before any per-input call (off/unauthorized/unavailable). `run` is then null. */
  staticMode: ReturnedJudgeMode | null;
  /** The selected backend, ready to run per input. Null when `staticMode` is terminal. */
  run: ((input: DiffInput) => Promise<Finding[]>) | null;
  /** The mode to report when `run` succeeds. */
  readyMode: "local" | "anthropic" | null;
}

async function planJudge(judgeSel: JudgeMode, allowJudge: boolean): Promise<JudgePlan> {
  if (judgeSel === "off") return { staticMode: "off", run: null, readyMode: null };
  if (!allowJudge) return { staticMode: "unauthorized", run: null, readyMode: null };
  const resolved = await resolveJudge(judgeSel);
  if (!resolved.available || resolved.mode === "off") {
    // "auto" degrading to deterministic is the documented contract ("off"); an EXPLICIT backend that
    // can't run is a distinct, named condition ("unavailable") — never a silent "ran and found nothing".
    return { staticMode: resolved.mode === "off" ? "off" : "unavailable", run: null, readyMode: null };
  }
  return { staticMode: null, run: resolved.judge, readyMode: resolved.mode };
}

export async function reconcileEndpoint(json: unknown, opts?: { allowJudge?: boolean }): Promise<EndpointResponse> {
  const parsed = ReconcileBody.safeParse(json);
  if (!parsed.success) return { status: 422, body: { error: "invalid body", issues: parsed.error.issues } };
  const b = parsed.data;

  const input = toDiffInput(b.agent, b.task, b.claim, b.authorized, b.evidence);
  const r = await buildReceipt(input);

  // The hashed receipt stays the DETERMINISTIC verdict (reproducible); judge findings are returned
  // separately and badged llmAssisted — an LLM never silently changes the tamper-evident receipt.
  const plan = await planJudge(b.judge, opts?.allowJudge ?? false);
  let judgeMode: ReturnedJudgeMode = plan.staticMode ?? plan.readyMode ?? "off";
  let judgeFindings: Finding[] = [];
  if (plan.run) {
    try {
      judgeFindings = await plan.run(input);
    } catch {
      judgeMode = "error"; // judge failed (timeout/5xx) — keep the 200 deterministic verdict
      judgeFindings = [];
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

// ── Batch: per-claim supported / unsupported / overclaim ────────────────────────────────────────────

/** The three-way per-claim verdict the seam returns (deterministic-first):
 *   - "supported":   zero findings — the claim reconciles with the evidence under the deterministic rules.
 *   - "overclaim":   a deterministic OVERSPEND / SCOPE_CREEP / UNAUTH_RECURRENCE — the claim or action
 *                    exceeded what the authorization/evidence supports. This is the deterministic floor,
 *                    so it takes precedence when a claim trips multiple findings.
 *   - "unsupported": only a CLAIM_MISMATCH remains — the claim contradicts the evidence. The deterministic
 *                    engine ABSTAINS on this by design, so it appears ONLY when the gated LLM judge flagged
 *                    it (llmAssisted). With the judge off, an unfaultable claim reads "supported". */
export type ClaimStatus = "supported" | "unsupported" | "overclaim";

const OVERCLAIM_TYPES: readonly FindingType[] = ["OVERSPEND", "SCOPE_CREEP", "UNAUTH_RECURRENCE"];

/** Classify a claim from its combined deterministic + judge findings. Pure; no LLM. */
export function classifyClaim(findings: readonly Finding[]): ClaimStatus {
  if (findings.length === 0) return "supported";
  if (findings.some((f) => OVERCLAIM_TYPES.includes(f.type))) return "overclaim";
  return "unsupported"; // only CLAIM_MISMATCH (the judge residual) remains
}

/** One claim's verdict in a batch response. Deterministic findings and judge findings stay SEPARATE so
 *  a caller can always tell which signal came from a rule vs. the gated LLM. */
export interface ClaimVerdict {
  /** Echoed caller id, or the 0-based index as a string when none was supplied. */
  id: string;
  agent: string;
  status: ClaimStatus;
  /** The deterministic verdict (zero findings == balanced). The judge never flips this. */
  balanced: boolean;
  findings: Finding[];
  /** Judge findings (badged llmAssisted); [] unless the gated judge ran and flagged the residual. */
  judgeFindings: Finding[];
  deltaUsd: number | null;
  likelyCause: string | null;
  receiptId: string;
  receiptHash: string;
}

export interface ReconcileBatchSuccess {
  merchant: string;
  judgeMode: ReturnedJudgeMode;
  claims: ClaimVerdict[];
  summary: { total: number; supported: number; unsupported: number; overclaim: number };
}

export type BatchEndpointResponse =
  | { status: 200; body: ReconcileBatchSuccess }
  | { status: 422; body: { error: string; issues: unknown } };

/** Reconcile N claims against ONE shared body of evidence, returning a per-claim supported/unsupported/
 *  overclaim verdict + receipt. Deterministic-first: the verdict and receipt never need a key. The judge
 *  is resolved once (auth-gated) and, if available, run per claim on the abstained residual; a failure on
 *  ANY claim degrades judgeMode to "error" (honest) while every deterministic verdict is still returned. */
export async function reconcileBatch(json: unknown, opts?: { allowJudge?: boolean }): Promise<BatchEndpointResponse> {
  const parsed = ReconcileBatchBody.safeParse(json);
  if (!parsed.success) return { status: 422, body: { error: "invalid body", issues: parsed.error.issues } };
  const b = parsed.data;

  const plan = await planJudge(b.judge, opts?.allowJudge ?? false);
  let judgeMode: ReturnedJudgeMode = plan.staticMode ?? plan.readyMode ?? "off";

  const claims: ClaimVerdict[] = [];
  for (const [i, c] of b.claims.entries()) {
    const input = toDiffInput(c.agent, c.task, c.claim, c.authorized, b.evidence);
    const r = await buildReceipt(input);

    let judgeFindings: Finding[] = [];
    if (plan.run) {
      try {
        judgeFindings = await plan.run(input);
      } catch {
        judgeMode = "error"; // sticky: one failed judge call marks the whole batch's judge mode honestly
        judgeFindings = [];
      }
    }

    claims.push({
      id: c.id ?? String(i),
      agent: c.agent,
      status: classifyClaim([...r.verdict.findings, ...judgeFindings]),
      balanced: r.verdict.balanced,
      findings: r.verdict.findings,
      judgeFindings,
      deltaUsd: r.verdict.deltaUsd ?? null,
      likelyCause: r.likelyCause,
      receiptId: r.receiptId,
      receiptHash: r.receiptHash,
    });
  }

  const summary = {
    total: claims.length,
    supported: claims.filter((c) => c.status === "supported").length,
    unsupported: claims.filter((c) => c.status === "unsupported").length,
    overclaim: claims.filter((c) => c.status === "overclaim").length,
  };

  return { status: 200, body: { merchant: b.evidence.merchant, judgeMode, claims, summary } };
}

/** Build the engine's DiffInput from the validated wire fields (shared by single + batch). */
function toDiffInput(
  agent: string,
  task: string,
  claim: string,
  authorized: z.infer<typeof AuthorizedSchema>,
  evidence: z.infer<typeof EvidenceSchema>,
): DiffInput {
  return {
    claim: { agent, task, text: claim, authorized },
    evidence: {
      source: "pasted",
      merchant: evidence.merchant,
      amountUsd: evidence.amountUsd ?? null,
      date: evidence.date ?? null,
      items: evidence.items,
      recurring: evidence.recurring,
      recurringPeriod: evidence.recurringPeriod,
      excerpt: evidence.excerpt,
    },
  };
}
