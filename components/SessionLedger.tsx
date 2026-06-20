"use client";

import { useEffect, useState, type ReactNode } from "react";
import { fingerprint } from "@/lib/engine/receipt-hash";
import type { AgentClaim, Finding, MerchantEvidence } from "@/lib/engine/types";
import { Receipt } from "./Receipt";

/* ── wire shapes (mirrors lib/store/receipt-store.ts + lib/api/ingest-endpoint.ts) ── */

interface LedgerReceipt {
  receiptId: string;
  receiptHash: string;
  balanced: boolean;
  findingTypes: string[];
  agent: string;
  merchant: string;
  deltaUsd: number | null;
  createdAt: number;
  seenCount?: number;
}

interface LedgerResponse {
  scope: string;
  session: string | null;
  backend: "sqlite" | "memory";
  total: number;
  events: number;
  flagged: number;
  byType: Record<string, number>;
  receipts: LedgerReceipt[];
}

interface IngestSuccess {
  agent: string;
  merchant: string;
  balanced: boolean;
  findings: Finding[];
  deltaUsd: number | null;
  likelyCause: string | null;
  receiptId: string;
  receiptHash: string;
  source: "email";
  evidence: MerchantEvidence;
}

/** A clearly-labelled SAMPLE confirmation — illustrative, not a real charge. The `.example` sender is a
 *  reserved, non-routable domain (RFC 2606), so this impersonates no real merchant. Reconciles to an
 *  UNAUTHORIZED recurring charge against a "free trial only" authorization. */
const SAMPLE = {
  agent: "comet",
  task: "Start the free PDF-tool trial only — do not pay for anything.",
  claim: "Activated the free trial. No charge to you.",
  budgetUsd: 0,
  mayPurchase: false,
  mayRecur: false,
  scope: "free trial only",
  from: "Stackly Pro <billing@stackly.example>",
  subject: "[SAMPLE] Your Stackly Pro subscription is active",
  body: [
    "[SAMPLE — illustrative confirmation, not a real charge]",
    "",
    "Welcome to Stackly Pro!",
    "Plan: Stackly Pro — Monthly",
    "Amount charged: $14.99",
    "Your subscription will renew automatically every month.",
  ].join("\n"),
  receivedAt: "2026-06-14",
};

type Status = "idle" | "running" | "done" | "gated" | "error";

/** Read this session's ledger from /api/ledger. Returns the response, "gated" (key-gated), or null
 *  (transient error — keep the last-known history). Pure of React state, so callers own the setState. */
async function fetchLedger(key: string): Promise<LedgerResponse | "gated" | null> {
  if (!key) return null;
  try {
    const res = await fetch(`/api/ledger?session=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (res.status === 401) return "gated";
    if (res.ok) return (await res.json()) as LedgerResponse;
    return null;
  } catch {
    return null;
  }
}

export function SessionLedger() {
  const [session, setSession] = useState("");

  // ── record: the forwarded-confirmation form ──
  const [agent, setAgent] = useState("api");
  const [task, setTask] = useState("");
  const [claimText, setClaimText] = useState("");
  const [budgetUsd, setBudgetUsd] = useState<number | null>(null);
  const [mayPurchase, setMayPurchase] = useState(true);
  const [mayRecur, setMayRecur] = useState(false);
  const [scope, setScope] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [receivedAt, setReceivedAt] = useState("");

  // ── reconcile: the resulting receipt, captured against the exact inputs that produced it ──
  const [result, setResult] = useState<{ success: IngestSuccess; claim: AgentClaim } | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // ── review: the per-session history ──
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [ledgerGated, setLedgerGated] = useState(false);

  // Apply a fetched ledger to state. Called only after an `await` (effect) or from an event handler —
  // never synchronously inside an effect body — so it can't trigger a cascading render.
  function applyLedger(data: LedgerResponse | "gated" | null) {
    if (data === "gated") setLedgerGated(true);
    else if (data) {
      setLedgerGated(false);
      setLedger(data);
    }
  }

  // A per-browser session key, persisted locally. It scopes BOTH the GET ledger (?session=) and the
  // POST ingest (x-pacioli-session header) so this device sees only its own receipts. localStorage is
  // client-only, so this must run in an effect; the initial history fetch resolves before any setState.
  useEffect(() => {
    let s = localStorage.getItem("pacioli.session");
    if (!s) {
      s = crypto.randomUUID();
      localStorage.setItem("pacioli.session", s);
    }
    const key = s;
    let cancelled = false;
    void (async () => {
      const data = await fetchLedger(key);
      if (cancelled) return;
      setSession(key);
      applyLedger(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function loadSample() {
    setAgent(SAMPLE.agent);
    setTask(SAMPLE.task);
    setClaimText(SAMPLE.claim);
    setBudgetUsd(SAMPLE.budgetUsd);
    setMayPurchase(SAMPLE.mayPurchase);
    setMayRecur(SAMPLE.mayRecur);
    setScope(SAMPLE.scope);
    setFrom(SAMPLE.from);
    setSubject(SAMPLE.subject);
    setBody(SAMPLE.body);
    setReceivedAt(SAMPLE.receivedAt);
    setStatus("idle");
    setError(null);
  }

  function resetSession() {
    const s = crypto.randomUUID();
    localStorage.setItem("pacioli.session", s);
    setSession(s);
    setResult(null);
    setLedger(null);
    setStatus("idle");
  }

  async function ingest(e: React.FormEvent) {
    e.preventDefault();
    if (!task.trim() || !claimText.trim() || !body.trim()) {
      setError("Task, the agent's claim, and the confirmation body are all required.");
      setStatus("error");
      return;
    }
    setStatus("running");
    setError(null);

    const claim: AgentClaim = {
      agent: agent.trim() || "api",
      task,
      text: claimText,
      authorized: { budgetUsd, scope: scope.trim() || undefined, mayPurchase, mayRecur },
    };
    const payload = {
      agent: claim.agent,
      task,
      claim: claimText,
      authorized: claim.authorized,
      confirmation: { from, subject, body, receivedAt: receivedAt.trim() || undefined },
    };

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pacioli-session": session },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        setStatus("gated");
        return;
      }
      if (res.status === 413) {
        setError("That confirmation is too large (128 KB limit).");
        setStatus("error");
        return;
      }
      if (!res.ok) {
        setError(res.status === 422 ? "The payload was shape-invalid (check the required fields)." : `Ingest failed (HTTP ${res.status}).`);
        setStatus("error");
        return;
      }
      const success = (await res.json()) as IngestSuccess;
      setResult({ success, claim });
      setStatus("done");
      applyLedger(await fetchLedger(session));
    } catch {
      setError("Network error — is the server running?");
      setStatus("error");
    }
  }

  return (
    <section aria-labelledby="your-ledger" className="border-b border-cream/10 pb-16">
      <div className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cream-dim">Your ledger</p>
        <h2 id="your-ledger" className="mt-4 font-serif text-[clamp(26px,4vw,40px)] font-medium leading-[1.08] tracking-tight text-cream">
          Record &rarr; reconcile &rarr; review.
        </h2>
        <p className="mt-5 font-serif text-[17px] italic leading-relaxed text-cream/80">
          Forward a merchant confirmation. Pacioli extracts the evidence, reconciles it against what you{" "}
          <span className="not-italic text-cream">authorized</span>, files a tamper-evident receipt in your
          ledger, and surfaces the ones that don&rsquo;t balance. This loop is live — it runs against the same
          deterministic engine, scoped to this browser. Nothing is shown that you didn&rsquo;t enter.
        </p>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_minmax(0,400px)] lg:items-start">
        {/* ── RECORD ── */}
        <form onSubmit={ingest} className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>Forward a confirmation, or load a sample</Eyebrow>
            <button
              type="button"
              onClick={loadSample}
              className="rounded-sm border border-cream/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-cream-dim transition-colors hover:border-cream/50 hover:text-cream"
            >
              Load a [SAMPLE] confirmation
            </button>
          </div>

          <div className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
            <Field label="The agent">
              <TextInput value={agent} onChange={setAgent} placeholder="api" />
            </Field>
            <Field label="Scope (what you authorized)">
              <TextInput value={scope} onChange={setScope} placeholder="e.g. free trial only" />
            </Field>
            <Field label="You asked" className="sm:col-span-2">
              <TextArea value={task} onChange={setTask} rows={2} placeholder="The instruction you gave the agent" />
            </Field>
            <Field label="It claimed" className="sm:col-span-2">
              <TextArea value={claimText} onChange={setClaimText} rows={2} placeholder="What the agent reported it did" />
            </Field>
            <Field label="Authorized budget (USD)">
              <NumInput value={budgetUsd} onChange={setBudgetUsd} placeholder="none" />
            </Field>
            <div className="flex items-end gap-5">
              <Toggle label="May purchase" checked={mayPurchase} onChange={setMayPurchase} />
              <Toggle label="May recur" checked={mayRecur} onChange={setMayRecur} />
            </div>

            <div className="sm:col-span-2 mt-1 border-t border-cream/10 pt-4">
              <Eyebrow>The forwarded confirmation</Eyebrow>
            </div>
            <Field label="From">
              <TextInput value={from} onChange={setFrom} placeholder="Merchant <receipts@merchant.com>" />
            </Field>
            <Field label="Received (date)">
              <TextInput value={receivedAt} onChange={setReceivedAt} placeholder="YYYY-MM-DD" />
            </Field>
            <Field label="Subject" className="sm:col-span-2">
              <TextInput value={subject} onChange={setSubject} placeholder="Your receipt / order confirmation" />
            </Field>
            <Field label="Body (the confirmation text — parsed, never stored)" className="sm:col-span-2">
              <TextArea value={body} onChange={setBody} rows={6} placeholder="Paste the plain-text confirmation email" />
            </Field>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={status === "running"}
              className="rounded-sm border border-ledger-green/60 bg-ledger-green/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-cream transition-colors hover:bg-ledger-green/25 disabled:opacity-50"
            >
              {status === "running" ? "Reconciling…" : "Reconcile and file the receipt"}
            </button>
            <p className="font-mono text-[10px] leading-relaxed text-cream-dim">
              Deterministic · no key required · the raw body is parsed in-memory and never persisted.
            </p>
          </div>

          {status === "gated" && (
            <p className="mt-4 rounded-sm border border-cream/15 bg-desk-2/60 p-3 font-mono text-[11px] leading-relaxed text-cream-dim">
              This deployment is key-gated — ingestion and the session ledger require <code>PACIOLI_API_KEY</code> on
              the server (with <code>x-api-key</code> on each call). The browser never holds that secret, so this loop
              is disabled here. Run it locally with no key set, or use the deterministic demo on the home page.
            </p>
          )}
          {status === "error" && error && (
            <p className="mt-4 font-mono text-[11px] text-oxblood">{error}</p>
          )}
        </form>

        {/* ── RECONCILE: the resulting receipt ── */}
        <div className="lg:sticky lg:top-8 flex justify-center lg:justify-end">
          {result ? (
            <Receipt
              key={result.success.receiptId}
              claim={result.claim}
              evidence={result.success.evidence}
              verdict={{
                balanced: result.success.balanced,
                findings: result.success.findings,
                deltaUsd: result.success.deltaUsd ?? undefined,
              }}
              no={result.success.receiptId.replace("sha256:", "").slice(0, 4).toUpperCase()}
              contentHash={fingerprint(result.success.receiptHash)}
              likelyCause={result.success.likelyCause ?? undefined}
            />
          ) : (
            <div className="w-full max-w-[360px] rounded-sm border border-dashed border-cream/15 bg-desk-2/40 p-8 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cream-dim">No receipt yet</p>
              <p className="mt-3 text-[13.5px] leading-relaxed text-cream/60">
                Forward a confirmation (or load the sample) and reconcile it — the receipt prints here and is filed in
                your ledger below.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── REVIEW: the per-session history ── */}
      <LedgerHistory ledger={ledger} gated={ledgerGated} session={session} onReset={resetSession} />
    </section>
  );
}

/* ── the per-session receipt history ── */

function LedgerHistory({
  ledger,
  gated,
  session,
  onReset,
}: {
  ledger: LedgerResponse | null;
  gated: boolean;
  session: string;
  onReset: () => void;
}) {
  return (
    <div className="mt-14 border-t border-cream/10 pt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Your receipt history</Eyebrow>
          <p className="mt-2 text-[13.5px] leading-relaxed text-cream/70">
            Read back live from <code className="font-mono text-cream">/api/ledger</code>, scoped to this browser
            session. {ledger && <BackendNote backend={ledger.backend} />}
          </p>
        </div>
        {session && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-sm border border-cream/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-cream-dim transition-colors hover:border-cream/40 hover:text-cream"
            title="Start a fresh, empty session ledger"
          >
            Session {session.slice(0, 8)} · reset
          </button>
        )}
      </div>

      {gated ? (
        <p className="mt-6 rounded-sm border border-cream/15 bg-desk-2/60 p-3 font-mono text-[11px] text-cream-dim">
          The ledger API is key-gated on this deployment.
        </p>
      ) : !ledger || ledger.receipts.length === 0 ? (
        <p className="mt-6 rounded-sm border border-dashed border-cream/15 bg-desk-2/40 p-6 text-center font-mono text-[12px] text-cream-dim">
          No receipts in this session yet. Reconcile a confirmation above to start your ledger.
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-wide">
            <Stat label="receipts" value={String(ledger.total)} />
            <Stat label="events" value={String(ledger.events)} />
            <Stat label="flagged" value={String(ledger.flagged)} tone={ledger.flagged > 0 ? "bad" : "ok"} />
            {Object.entries(ledger.byType).map(([t, n]) => (
              <Stat key={t} label={t} value={String(n)} tone="bad" />
            ))}
          </div>

          <ul className="mt-5 divide-y divide-cream/8 overflow-hidden rounded-sm border border-cream/12">
            {ledger.receipts.map((r) => (
              <li key={r.receiptId} className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-desk-2/40 px-4 py-3">
                <span
                  className={`inline-flex h-2 w-2 flex-none rounded-full ${r.balanced ? "bg-ledger-green" : "bg-oxblood"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-serif text-[15px] text-cream">{r.merchant || "—"}</span>
                <span className="font-mono text-[11px] text-cream-dim">{r.agent}</span>
                {r.findingTypes.map((t) => (
                  <span key={t} className="rounded-sm border border-oxblood/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-oxblood">
                    {t}
                  </span>
                ))}
                {typeof r.deltaUsd === "number" && r.deltaUsd > 0 && (
                  <span className="font-mono text-[11px] tabular-nums text-oxblood">+${r.deltaUsd.toLocaleString("en-US")}</span>
                )}
                <span className="font-mono text-[10px] text-cream-dim" title={r.receiptId}>
                  {r.receiptId.replace("sha256:", "").slice(0, 10)}
                </span>
                <span className="font-mono text-[10px] text-cream-dim">
                  {new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function BackendNote({ backend }: { backend: "sqlite" | "memory" }) {
  return backend === "sqlite" ? (
    <span className="text-cream/70">
      Store: <span className="font-mono text-cream">sqlite</span> — durable across restarts.
    </span>
  ) : (
    <span className="text-cream/70">
      Store: <span className="font-mono text-cream">memory</span> — receipts persist while the server process is warm;
      set <code className="font-mono">PACIOLI_DB</code> for a durable ledger.
    </span>
  );
}

/* ── field primitives (matched to the home-page demo console) ── */

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-cream-dim">{children}</p>;
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-cream-dim">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-sm border border-cream/15 bg-desk-2 px-3 py-2 font-mono text-[13px] text-cream placeholder:text-cream-dim/50 focus:border-cream/40";

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="text" className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function TextArea({ value, onChange, rows = 2, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <textarea
      className={`${inputCls} resize-y leading-relaxed`}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumInput({ value, onChange, placeholder }: { value: number | null; onChange: (n: number | null) => void; placeholder?: string }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      className={`${inputCls} tabular-nums`}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (t === "") return onChange(null);
        const n = Number(t);
        onChange(Number.isNaN(n) ? null : n);
      }}
    />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
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
        <span className={`absolute top-1 h-4 w-4 rounded-full transition-all ${checked ? "left-6 bg-ledger-green" : "left-1 bg-cream-dim"}`} />
      </button>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-cream-dim">{label}</span>
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  const color = tone === "bad" ? "text-oxblood" : tone === "ok" ? "text-ledger-green" : "text-cream";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-cream/12 bg-desk-2/50 px-2.5 py-1">
      <span className={`tabular-nums ${color}`}>{value}</span>
      <span className="text-cream-dim">{label}</span>
    </span>
  );
}
