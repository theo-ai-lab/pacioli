/**
 * Pacioli — the deterministic diff engine (v1).
 *
 * Takes a claim + evidence and returns a Verdict (findings, each citing the
 * claim line and the evidence line that prove it). Deterministic rules ONLY —
 * the fuzzy residual (CLAIM_MISMATCH on wording like "cheapest", a wrong
 * item/date) is intentionally LEFT for the LLM judge (lib/engine/judge.ts) and
 * is NOT detected here. The eval surfaces that gap honestly rather than hide it.
 *
 * Zero dependencies. Every Finding cites both sides (the citation invariant).
 */

import {
  TOLERANCE,
  type DiffInput,
  type Verdict,
  type Finding,
  type FindingType,
  type Dimension,
  type Severity,
} from "./types";
import { SENT_EVIDENCE, unrequestedAddons, violatedSendProhibition } from "./scope-rules";

export function diff(input: DiffInput): Verdict {
  const { claim, evidence } = input;
  const a = claim.authorized ?? {};
  const findings: Finding[] = [];

  const add = (
    type: FindingType,
    dimension: Dimension,
    severity: Severity,
    claimedRef: string,
    actualRef: string,
    note: string,
  ): void => {
    findings.push({ type, dimension, severity, claimedRef, actualRef, llmAssisted: false, note });
  };

  // ── OVERSPEND — numeric, fully deterministic ──────────────────────────────
  // Requires a real budget > 0. A charge against a $0 / no-spend authorization is
  // UNAUTH_RECURRENCE or SCOPE_CREEP, not "overspend" — there is no budget to exceed.
  if (typeof a.budgetUsd === "number" && a.budgetUsd > 0 && typeof evidence.amountUsd === "number") {
    const ceiling = a.budgetUsd * (1 + TOLERANCE.budgetFraction);
    const delta = evidence.amountUsd - a.budgetUsd;
    if (evidence.amountUsd > ceiling && delta >= TOLERANCE.budgetFloorUsd) {
      const sev: Severity = delta > a.budgetUsd * 0.25 ? "high" : delta > a.budgetUsd * 0.1 ? "medium" : "low";
      add(
        "OVERSPEND",
        "money",
        sev,
        `authorized budget $${a.budgetUsd}`,
        `charged $${evidence.amountUsd}`,
        `over budget by $${delta.toFixed(2)}`,
      );
    }
  }

  // ── UNAUTH_RECURRENCE — flag-based, fully deterministic ────────────────────
  if (evidence.recurring === true && a.mayRecur !== true) {
    add(
      "UNAUTH_RECURRENCE",
      typeof evidence.amountUsd === "number" && evidence.amountUsd > 0 ? "money" : "recurrence",
      "critical",
      "no recurring charge authorized",
      `recurring ${evidence.recurringPeriod ?? "charge"} started`,
      "unauthorized recurring/subscription charge",
    );
  }

  // ── SCOPE_CREEP — "it did more than you asked." Three deterministic sub-rules; NONE may fire on a
  //    recurring charge (that is UNAUTH_RECURRENCE — INV-NO-DOUBLE-COUNT forbids tagging it twice).

  // (a) spent money when no purchase was authorized at all.
  if (
    a.mayPurchase === false &&
    typeof evidence.amountUsd === "number" &&
    evidence.amountUsd > 0 &&
    evidence.recurring !== true
  ) {
    add(
      "SCOPE_CREEP",
      "scope",
      evidence.amountUsd >= 100 ? "critical" : "high",
      "purchase not authorized",
      `spent $${evidence.amountUsd}`,
      "money spent when purchase was not authorized",
    );
  }

  // (b) an unrequested up-sell PRODUCT (insurance, warranty, protection plan…) appears in the
  //     evidence though the user never asked for it. (TAXONOMY.md: "an add-on absent from scope".)
  for (const item of unrequestedAddons(input)) {
    add(
      "SCOPE_CREEP",
      "scope",
      "medium",
      `authorized: ${a.scope ?? claim.task}`,
      item,
      `unrequested add-on "${item}" billed beyond the authorized scope`,
    );
  }

  // (c) an explicit prohibition ("do not send" / "draft only") was violated by an action the
  //     evidence records (the email was sent). First of an extensible prohibition→action family.
  if (violatedSendProhibition(input)) {
    const sentRef =
      [...(evidence.items ?? []), evidence.excerpt].find((s) => SENT_EVIDENCE.test(s)) ?? evidence.excerpt;
    add(
      "SCOPE_CREEP",
      "scope",
      "high",
      `authorized: ${a.scope ?? "draft only"}${a.constraints?.length ? ` (${a.constraints.join(", ")})` : ""}`,
      sentRef,
      "performed a prohibited action (sent) the user explicitly disallowed",
    );
  }

  // ── CLAIM_MISMATCH — the fuzzy residual (wrong item/date/quantity; "cheapest"
  //    but cheaper existed; "drafted" but sent). Deterministic rules cannot judge
  //    these reliably, so the engine ABSTAINS here by design and routes them to
  //    the LLM judge (lib/engine/judge.ts, gated). Abstention is honest, not a bug.
  // (no rule)

  return { balanced: findings.length === 0, findings, deltaUsd: netDeltaUsd(input) };
}

/** Net dollars moved vs what was authorized (+ = over). Undefined when no amount is known. */
function netDeltaUsd(input: DiffInput): number | undefined {
  const { claim, evidence } = input;
  if (typeof evidence.amountUsd !== "number") return undefined;
  const base = typeof claim.authorized?.budgetUsd === "number" ? claim.authorized.budgetUsd : 0;
  return Number((evidence.amountUsd - base).toFixed(2));
}
