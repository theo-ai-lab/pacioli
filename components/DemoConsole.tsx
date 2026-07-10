"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { diff } from "@pacioli-app/engine";
import { EXAMPLES, EXAMPLE_BY_ID } from "@/lib/examples";
import { topHypothesis } from "@pacioli-app/engine";
import { receiptHash, fingerprint } from "@pacioli-app/engine";
import type { AgentClaim, Finding, MerchantEvidence, Verdict } from "@pacioli-app/engine";
import { Receipt } from "./Receipt";
import { StreamingJudgePanel } from "./StreamingJudgePanel";
import { runJudge } from "@/app/actions/judge";

const clone = <T,>(x: T): T => structuredClone(x);
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
};

export function DemoConsole() {
  const [id, setId] = useState(EXAMPLES[0].id);
  const [claim, setClaim] = useState<AgentClaim>(() => clone(EXAMPLES[0].claim));
  const [evidence, setEvidence] = useState<MerchantEvidence>(() => clone(EXAMPLES[0].evidence));
  const [showJudge, setShowJudge] = useState(false);
  const [liveJudge, setLiveJudge] = useState<Finding[] | null>(null);
  const [judgeStatus, setJudgeStatus] = useState<"idle" | "running" | "gated" | "limited" | "done" | "error">("idle");

  const example = EXAMPLE_BY_ID[id];

  function select(exId: string) {
    const ex = EXAMPLE_BY_ID[exId];
    setId(exId);
    setClaim(clone(ex.claim));
    setEvidence(clone(ex.evidence));
    setShowJudge(false);
    setLiveJudge(null);
    setJudgeStatus("idle");
  }

  // Any edit invalidates a revealed/live judge finding (it was cited against the
  // pre-edit input), so editing resets the judge to keep the citation invariant.
  function resetJudge() {
    setShowJudge(false);
    setLiveJudge(null);
    setJudgeStatus("idle");
  }
  const patchClaim = (patch: Partial<AgentClaim>) => {
    resetJudge();
    setClaim((c) => ({ ...c, ...patch }));
  };
  const setAuth = (patch: Partial<AgentClaim["authorized"]>) => {
    resetJudge();
    setClaim((c) => ({ ...c, authorized: { ...c.authorized, ...patch } }));
  };
  const setEv = (patch: Partial<MerchantEvidence>) => {
    resetJudge();
    setEvidence((e) => ({ ...e, ...patch }));
  };

  const verdict: Verdict = useMemo(() => {
    const base = diff({ claim, evidence });
    const extra: Finding[] = showJudge ? (liveJudge ?? example.judgeFindings ?? []) : [];
    const findings = [...base.findings, ...extra];
    return { ...base, findings, balanced: findings.length === 0 };
  }, [claim, evidence, showJudge, liveJudge, example]);

  const deterministicClean = diff({ claim, evidence }).balanced;

  // diagnosis (deterministic) + a tamper-evident content hash (async, Web Crypto)
  const likelyCause = useMemo(
    () => topHypothesis(verdict.findings, { claim, evidence })?.cause,
    [verdict, claim, evidence],
  );
  const [hash, setHash] = useState<string>();
  useEffect(() => {
    let alive = true;
    receiptHash({ claim, evidence }, verdict).then((h) => {
      if (alive) setHash(fingerprint(h));
    });
    return () => {
      alive = false;
    };
  }, [claim, evidence, verdict]);

  async function runLiveJudge() {
    setJudgeStatus("running");
    try {
      const res = await runJudge({ claim, evidence });
      if (!res.enabled) {
        setJudgeStatus("gated");
        return;
      }
      if (res.error === "rate-limited" || res.error === "daily-limit") {
        setJudgeStatus("limited");
        return;
      }
      setLiveJudge(res.findings);
      setShowJudge(true);
      setJudgeStatus(res.error ? "error" : "done");
    } catch {
      setJudgeStatus("error");
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_minmax(0,420px)] lg:items-start">
      {/* ── editor ── */}
      <div className="min-w-0">
        <Eyebrow>Pick a scenario, or edit any field</Eyebrow>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => select(ex.id)}
              aria-pressed={ex.id === id}
              className={`rounded-sm border px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors ${
                ex.id === id
                  ? "border-cream/70 bg-cream/10 text-cream"
                  : "border-cream/15 text-cream-dim hover:border-cream/40 hover:text-cream"
              }`}
              title={ex.blurb}
            >
              {ex.chip}
            </button>
          ))}
        </div>

        <div className="mt-7 grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <Field label="The agent" className="sm:col-span-2">
            <TextInput value={claim.agent} onChange={(v) => patchClaim({ agent: v })} />
          </Field>
          <Field label="You asked" className="sm:col-span-2">
            <TextArea value={claim.task} onChange={(v) => patchClaim({ task: v })} rows={2} />
          </Field>
          <Field label="It claimed" className="sm:col-span-2">
            <TextArea value={claim.text} onChange={(v) => patchClaim({ text: v })} rows={2} />
          </Field>

          <Field label="Authorized budget (USD)">
            <NumInput
              value={claim.authorized.budgetUsd ?? null}
              onChange={(n) => setAuth({ budgetUsd: n })}
              placeholder="none"
            />
          </Field>
          <div className="flex items-end gap-5">
            <Toggle
              label="May purchase"
              checked={claim.authorized.mayPurchase === true}
              onChange={(b) => setAuth({ mayPurchase: b })}
            />
            <Toggle
              label="May recur"
              checked={claim.authorized.mayRecur === true}
              onChange={(b) => setAuth({ mayRecur: b })}
            />
          </div>

          <Field label="Merchant">
            <TextInput value={evidence.merchant} onChange={(v) => setEv({ merchant: v })} />
          </Field>
          <Field label="Amount actually charged (USD)">
            <NumInput
              value={evidence.amountUsd}
              onChange={(n) => setEv({ amountUsd: n })}
              placeholder="none"
            />
          </Field>

          <div className="flex items-end gap-5">
            <Toggle
              label="Recurring"
              checked={evidence.recurring}
              onChange={(b) => setEv({ recurring: b })}
            />
            {evidence.recurring && (
              <Field label="Period">
                <Select
                  value={evidence.recurringPeriod ?? "monthly"}
                  onChange={(v) => setEv({ recurringPeriod: v as MerchantEvidence["recurringPeriod"] })}
                  options={["weekly", "monthly", "annual"]}
                />
              </Field>
            )}
          </div>
          <Field label="Date">
            <TextInput value={evidence.date ?? ""} onChange={(v) => setEv({ date: v || null })} placeholder="YYYY-MM-DD" />
          </Field>

          <Field label="Items charged (comma-separated)" className="sm:col-span-2">
            <TextInput
              value={evidence.items.join(", ")}
              onChange={(v) => setEv({ items: v.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
        </div>

        <JudgePanel
          deterministicClean={deterministicClean}
          hasJudgeExample={Boolean(example.judgeFindings)}
          showJudge={showJudge}
          judgeStatus={judgeStatus}
          liveCount={liveJudge?.length ?? null}
          onReveal={() => setShowJudge(true)}
          onRunLive={runLiveJudge}
        />

        {/* Additive: the streamed judge (token-by-token + explicit low-confidence/abstain state). */}
        <StreamingJudgePanel claim={claim} evidence={evidence} />
      </div>

      {/* ── live receipt ── */}
      <div className="lg:sticky lg:top-8 flex justify-center lg:justify-end">
        <Receipt
          key={`${id}-${showJudge ? "j" : "d"}-${liveJudge ? liveJudge.length : "x"}`}
          claim={claim}
          evidence={evidence}
          verdict={verdict}
          no={example.no}
          contentHash={hash}
          likelyCause={likelyCause}
        />
      </div>
    </div>
  );
}

/* ── the deterministic ↔ judge boundary, made explicit ── */
function JudgePanel({
  deterministicClean,
  hasJudgeExample,
  showJudge,
  judgeStatus,
  liveCount,
  onReveal,
  onRunLive,
}: {
  deterministicClean: boolean;
  hasJudgeExample: boolean;
  showJudge: boolean;
  judgeStatus: "idle" | "running" | "gated" | "limited" | "done" | "error";
  liveCount: number | null;
  onReveal: () => void;
  onRunLive: () => void;
}) {
  return (
    <div className="mt-8 rounded-sm border border-cream/12 bg-desk-2/60 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cream-dim">
        Deterministic rules first · LLM judge on the residual
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-cream/75">
        The engine runs deterministic rules in your browser — instant, no account, no key. Overspend,
        unauthorized recurrence, and scope creep are exact. Fuzzy claim-vs-evidence mismatches (“cheapest”,
        wrong item or date) are <em>abstained</em> and routed to the LLM judge, which marks every finding{" "}
        <span className="text-oxblood">LLM-assisted</span>.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasJudgeExample && !showJudge && (
          <button
            type="button"
            onClick={onReveal}
            className="rounded-sm border border-oxblood/50 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-oxblood transition-colors hover:bg-oxblood/10"
          >
            Reveal what the judge finds →
          </button>
        )}
        <button
          type="button"
          onClick={onRunLive}
          disabled={judgeStatus === "running"}
          className="rounded-sm border border-cream/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-cream-dim transition-colors hover:border-cream/50 hover:text-cream disabled:opacity-50"
        >
          {judgeStatus === "running" ? "Running judge…" : "Run the live LLM judge"}
        </button>
      </div>

      {judgeStatus === "gated" && (
        <p className="mt-3 font-mono text-[11px] text-cream-dim">
          The live judge is gated — set <code>ANTHROPIC_API_KEY</code> on the server to enable it. Until then,
          deterministic-only{hasJudgeExample ? " — use “Reveal” to preview a judge finding." : "."}
        </p>
      )}
      {judgeStatus === "limited" && (
        <p className="mt-3 font-mono text-[11px] text-cream-dim">
          The live judge is rate-limited to keep the public demo cheap — try again in a moment, or use the
          deterministic result above.
        </p>
      )}
      {judgeStatus === "done" && (
        <p className="mt-3 font-mono text-[11px] text-cream-dim">
          Live judge returned {liveCount ?? 0} finding{liveCount === 1 ? "" : "s"}, badged{" "}
          <span className="text-oxblood">LLM-assisted</span>.
        </p>
      )}
      {judgeStatus === "error" && (
        <p className="mt-3 font-mono text-[11px] text-oxblood">The judge call failed — check the server logs.</p>
      )}
      {hasJudgeExample && showJudge && judgeStatus !== "done" && (
        <p className="mt-3 font-mono text-[11px] text-cream-dim">
          ↑ Added to the receipt, badged <span className="text-oxblood">LLM-assisted</span> (illustrative on this
          synthetic row).
        </p>
      )}
      {!hasJudgeExample && deterministicClean && judgeStatus === "idle" && (
        <p className="mt-3 font-mono text-[11px] text-cream-dim">
          These books balance on the deterministic rules. The live judge would still check the wording for a
          CLAIM_MISMATCH.
        </p>
      )}
    </div>
  );
}

/* ── tiny field primitives ── */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-cream-dim">{children}</p>;
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  // The single form control is nested in the label → implicit, accessible association.
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-cream-dim">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-sm border border-cream/15 bg-desk-2 px-3 py-2 font-mono text-[13px] text-cream placeholder:text-cream-dim/50 focus:border-cream/40";

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      className={inputCls}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextArea({
  value,
  onChange,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      className={`${inputCls} resize-y leading-relaxed`}
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      className={`${inputCls} tabular-nums`}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(numOrNull(e.target.value))}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full border transition-colors ${
          checked ? "border-ledger-green bg-ledger-green/30" : "border-cream/25 bg-desk-2"
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full transition-all ${
            checked ? "left-6 bg-ledger-green" : "left-1 bg-cream-dim"
          }`}
        />
      </button>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-cream-dim">{label}</span>
    </label>
  );
}
