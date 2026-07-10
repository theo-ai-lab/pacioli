"use client";

/**
 * Pacioli — the STREAMED judge panel (additive product surface).
 *
 * Calls POST /api/judge/stream and renders the judge writing its rationale token-by-token, then a
 * single EXPLICIT terminal state. The whole point is the honest middle state: when the judge is not
 * confident it does NOT assert a CLAIM_MISMATCH — it shows "uncertain — abstained" and adds no
 * finding to the receipt. A confident contradiction shows the badged finding; a confident pass shows
 * "the wording checks out". With no ANTHROPIC_API_KEY on the server the stream returns gated, and
 * the panel says so (deterministic-only), exactly like the non-streamed judge.
 *
 * Self-contained: it owns its own fetch + state and reads the current claim/evidence as props, so it
 * mounts alongside the existing deterministic console without touching it.
 */

import { useRef, useState } from "react";
import type { AgentClaim, Finding, MerchantEvidence } from "@pacioli-app/engine";

type Phase = "idle" | "streaming" | "match" | "clean" | "low-confidence" | "error" | "gated" | "limited";

type Frame =
  | { t: "delta"; text?: string }
  | { t: "final"; state?: string; confidence?: number; findings?: Finding[]; error?: string }
  | { t: "error"; message?: string };

export function StreamingJudgePanel({ claim, evidence }: { claim: AgentClaim; evidence: MerchantEvidence }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const runningRef = useRef(false);

  async function run() {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("streaming");
    setText("");
    setConfidence(null);
    setFindings([]);

    try {
      const res = await fetch("/api/judge/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim, evidence }),
      });

      // Gated / rate-limited responses come back as JSON, not a stream.
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("ndjson")) {
        const body = (await res.json().catch(() => ({}))) as { state?: string; enabled?: boolean; error?: string };
        if (body.enabled === false || body.state === "gated") setPhase("gated");
        else if (res.status === 429) setPhase("limited");
        else setPhase("error");
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setPhase("error");
        return;
      }
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let settled = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          let frame: Frame;
          try {
            frame = JSON.parse(raw) as Frame;
          } catch {
            continue;
          }
          if (frame.t === "delta") {
            acc += frame.text ?? "";
            setText(acc);
          } else if (frame.t === "final") {
            settled = true;
            setConfidence(typeof frame.confidence === "number" ? frame.confidence : null);
            setFindings(Array.isArray(frame.findings) ? frame.findings : []);
            setPhase(
              frame.state === "match"
                ? "match"
                : frame.state === "clean"
                  ? "clean"
                  : frame.state === "low-confidence"
                    ? "low-confidence"
                    : "error",
            );
          } else if (frame.t === "error") {
            settled = true;
            setPhase("error");
          }
        }
      }
      if (!settled) setPhase("error"); // stream ended without a terminal frame
    } catch {
      setPhase("error");
    } finally {
      runningRef.current = false;
    }
  }

  return (
    <div className="mt-4 rounded-sm border border-cream/12 bg-desk-2/60 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cream-dim">
        Streamed judge · token-by-token · abstains when unsure
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-cream/75">
        Watch the LLM judge reason in real time. It self-rates a confidence; below the floor it{" "}
        <em>abstains</em> rather than risk a hallucinated accusation — surfaced here as an explicit{" "}
        <span className="text-cream">low-confidence</span> state that adds nothing to the receipt.
      </p>

      <div className="mt-3">
        <button
          type="button"
          onClick={run}
          disabled={phase === "streaming"}
          className="rounded-sm border border-oxblood/50 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-oxblood transition-colors hover:bg-oxblood/10 disabled:opacity-50"
        >
          {phase === "streaming" ? "Streaming…" : "Stream the live judge →"}
        </button>
      </div>

      {(phase === "streaming" || text) && (
        <p
          aria-live="polite"
          className="mt-3 min-h-[1.5rem] whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-cream/85"
        >
          {text}
          {phase === "streaming" && <span className="ml-0.5 inline-block animate-pulse">▌</span>}
        </p>
      )}

      {phase === "match" && (
        <Banner tone="oxblood">
          CLAIM_MISMATCH — {confLabel(confidence)}, badged <span className="text-oxblood">LLM-assisted</span>.{" "}
          {findings[0]?.note}
        </Banner>
      )}
      {phase === "clean" && <Banner tone="green">The wording checks out — {confLabel(confidence)}, no finding added.</Banner>}
      {phase === "low-confidence" && (
        <Banner tone="dim">
          Uncertain — {confLabel(confidence)}. The judge <strong className="text-cream">abstained</strong>; nothing was
          added to the receipt. (Graceful degrade, not a verdict.)
        </Banner>
      )}
      {phase === "gated" && (
        <Banner tone="dim">
          The streamed judge is gated — set <code>ANTHROPIC_API_KEY</code> on the server to enable it. Deterministic-only
          until then.
        </Banner>
      )}
      {phase === "limited" && (
        <Banner tone="dim">Rate-limited to keep the public demo cheap — try again in a moment.</Banner>
      )}
      {phase === "error" && <Banner tone="oxblood">The stream failed — no finding was inferred. Check the server logs.</Banner>}
    </div>
  );
}

function confLabel(c: number | null): string {
  return c === null ? "confidence n/a" : `confidence ${(c * 100).toFixed(0)}%`;
}

function Banner({ tone, children }: { tone: "oxblood" | "green" | "dim"; children: React.ReactNode }) {
  const color = tone === "oxblood" ? "text-oxblood" : tone === "green" ? "text-ledger-green" : "text-cream-dim";
  return <p className={`mt-3 font-mono text-[11px] leading-relaxed ${color}`}>{children}</p>;
}
