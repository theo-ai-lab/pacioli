/**
 * Pacioli — judge router (selectable CLAIM_MISMATCH backend).
 *
 * The deterministic engine abstains on the fuzzy residual; a judge handles it. There are two:
 * the hosted Anthropic judge (judge.ts) and the on-device Ollama judge (local-judge.ts). This picks
 * one. `auto` prefers ON-DEVICE (free, private, no key) → hosted (if a key) → off (deterministic-only).
 * Every judge finding stays badged `llmAssisted`, so an LLM verdict never silently drives a decision.
 */
import type { DiffInput, Finding } from "@pacioli-app/engine";
import { judge, judgeEnabled } from "./judge";
import { localJudge, localJudgeAvailable } from "./local-judge";

export type JudgeMode = "auto" | "local" | "anthropic" | "off";

export interface ResolvedJudge {
  /** Which backend was actually selected. */
  mode: "local" | "anthropic" | "off";
  available: boolean;
  judge: (input: DiffInput) => Promise<Finding[]>;
}

const noop = async (): Promise<Finding[]> => [];
// The router just probed availability — skip local-judge's own redundant probe (one less round-trip).
const localNoReprobe = (i: DiffInput): Promise<Finding[]> => localJudge(i, { skipAvailabilityCheck: true });

export async function resolveJudge(mode: JudgeMode = "auto"): Promise<ResolvedJudge> {
  if (mode === "off") return { mode: "off", available: false, judge: noop };
  if (mode === "local") {
    const ok = await localJudgeAvailable();
    return { mode: "local", available: ok, judge: ok ? localNoReprobe : noop };
  }
  if (mode === "anthropic") {
    const ok = judgeEnabled();
    return { mode: "anthropic", available: ok, judge: ok ? judge : noop };
  }
  // auto: prefer on-device (private + free), then hosted, then deterministic-only
  if (await localJudgeAvailable()) return { mode: "local", available: true, judge: localNoReprobe };
  if (judgeEnabled()) return { mode: "anthropic", available: true, judge };
  return { mode: "off", available: false, judge: noop };
}
