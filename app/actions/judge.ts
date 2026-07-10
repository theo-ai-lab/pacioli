"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { judge, judgeEnabled } from "@/lib/engine/judge";
import { checkJudgeRate } from "@/lib/ratelimit";
import type { DiffInput, Finding } from "@pacioli-app/engine";

export interface JudgeResult {
  /** Whether the server has an ANTHROPIC_API_KEY. When false, the UI stays deterministic-only. */
  enabled: boolean;
  findings: Finding[];
  error?: string;
}

// runJudge is a public, unauthenticated server action that forwards to a paid LLM, so the
// untrusted client input is validated and BOUNDED before the call (defends against cost/DoS
// via oversized prompts). Unknown keys are stripped.
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

/** Run the gated LLM judge on the CLAIM_MISMATCH residual. Safe with no key (returns enabled:false). */
export async function runJudge(input: unknown): Promise<JudgeResult> {
  if (!judgeEnabled()) return { enabled: false, findings: [] };
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { enabled: true, findings: [], error: "invalid input" };

  // Deploy-safe: rate-limit the PAID judge by client IP, with a daily cost ceiling.
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "global";
  const rate = checkJudgeRate(ip);
  if (!rate.ok) return { enabled: true, findings: [], error: rate.reason === "daily" ? "daily-limit" : "rate-limited" };

  try {
    return { enabled: true, findings: await judge(parsed.data as DiffInput) };
  } catch (e) {
    return { enabled: true, findings: [], error: e instanceof Error ? e.message : "judge failed" };
  }
}
