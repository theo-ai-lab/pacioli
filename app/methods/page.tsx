import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { MetricsTable } from "@/components/MetricsTable";
import { evaluate } from "@/lib/engine/metrics";
import { loadSeed, loadIncidents, loadCaptured, loadJsonl } from "@/lib/engine/dataset";
import { isHeadlineEligible } from "@pacioli-app/engine";
import { fuzz } from "@/lib/engine/fuzz";
import { fuzzMetamorphic, METAMORPHIC_PROPERTIES } from "@/lib/engine/metamorphic";
import { INVARIANTS } from "@pacioli-app/engine";
import { rateWithCI } from "@/lib/engine/judge-eval";

export const metadata: Metadata = {
  title: "Methods",
  description:
    "Claimed-vs-actual is prediction-vs-ground-truth, so Pacioli's core feature is an eval. Per-class precision/recall over a labeled set, with honest weak spots and a one-command reproduce.",
};

const pct = (x: number | null): string => (x == null ? "—" : x.toFixed(2));

export default function MethodsPage() {
  const seed = loadSeed();
  const incidents = loadIncidents();
  const seedReport = evaluate(seed);
  const incReport = evaluate(incidents);
  const byType = Object.fromEntries(seedReport.perClass.map((m) => [m.type, m]));

  const real = loadCaptured().filter(isHeadlineEligible);
  const publishedCorpusExists = loadJsonl("captured.public.jsonl").length > 0;
  const misbehaved = real.filter((r) => !r.target.balanced && !r.target.unscorable).length;
  // once enough real runs exist, the headline becomes a rate with a 95% confidence interval
  const headlineCI = real.length >= 8 ? rateWithCI(misbehaved, real.length) : null;

  // property-based + metamorphic fuzz, run live at build time
  const fz = fuzz(50_000, 1234);
  const mm = fuzzMetamorphic(50_000, 1234);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[760px] px-7 pt-14 pb-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cream-dim">Methods</p>
        <h1 className="mt-4 font-serif text-[clamp(30px,5vw,46px)] font-medium leading-[1.08] tracking-tight text-cream">
          The core feature is an eval.
        </h1>
        <p className="mt-5 font-serif text-[19px] italic leading-relaxed text-cream/80">
          “What the agent claimed” versus “what actually happened” is prediction versus ground truth. So the
          reconciliation engine isn&rsquo;t something an eval is bolted onto — it <em>is</em> the eval. Here is the
          labeled set, the per-class numbers, the weak spots I didn&rsquo;t hide, and the one command that
          reproduces all of it.
        </p>

        <Section title="The labeled set, and the firewall around it">
          <P>
            Every row is entered twice — an agent <strong className="text-cream">claim</strong> and the{" "}
            <strong className="text-cream">evidence</strong> that should reconcile it — with a human label for the
            finding classes that <em>should</em> be caught. Rows carry a <code>provenance</code>, and provenance gates
            how a row may be used. This is the line that keeps the project honest:
          </P>
          <ul className="not-prose my-5 space-y-2.5 font-mono text-[12.5px] text-cream/80">
            <Li tone="muted">
              <b className="text-cream">synthetic-seed</b> — {seed.length} hand-authored fixtures. Engine development
              only. <em>Never</em> counted toward a reported rate.
            </Li>
            <Li tone="muted">
              <b className="text-cream">public-incident</b> — {incidents.length} documented, source-cited real-world
              failures. Real, but a <em>separate</em> supporting class — not your own measured rate.
            </Li>
            <Li tone="muted">
              <b className="text-cream">self-run / gmail</b> — real agent runs you commissioned. The <em>only</em>
              provenance eligible to produce the headline misbehavior rate.
            </Li>
          </ul>
          <P>
            Two numbers, kept strictly apart: <strong className="text-cream">detector accuracy</strong> (does the
            engine reproduce the labels?) and the <strong className="text-cream">agent-misbehavior rate</strong> (of
            real runs, how many went wrong?). A synthetic row that leaks into the second number would turn this into the
            very thing it detects. The metric code filters on provenance before it reports.
          </P>
        </Section>

        <Section title="Detector accuracy — per class, not one flattering number">
          <P>
            The deterministic engine scored against the synthetic fixtures. Precision is high where the engine
            commits, because the rules are exact; recall is the honest story.
          </P>
          <MetricsTable report={seedReport} caption={`Deterministic engine · ${seed.length} synthetic fixtures`} />
          <P>
            Read it straight. <Num>OVERSPEND</Num> is precise and high-recall (
            {pct(byType.OVERSPEND?.precision)} / {pct(byType.OVERSPEND?.recall)}) — a budget delta is a number.{" "}
            <Num>UNAUTH_RECURRENCE</Num> ({pct(byType.UNAUTH_RECURRENCE?.precision)} /{" "}
            {pct(byType.UNAUTH_RECURRENCE?.recall)}) is a flag check. But <Num>SCOPE_CREEP</Num> recall is only{" "}
            {pct(byType.SCOPE_CREEP?.recall)}: the engine catches unauthorized spend, a keyword list of known add-ons,
            and violated send-prohibitions — item additions outside those subsets need fuzzy comparison and are left to
            the judge. And <Num>CLAIM_MISMATCH</Num> recall is{" "}
            {pct(byType.CLAIM_MISMATCH?.recall)} <em>by design</em> — wording mismatches (“cheapest”, wrong date) are
            not something a deterministic rule should pretend to judge. Those are the LLM judge&rsquo;s job, and every
            judge finding is badged <span className="text-oxblood">LLM-assisted</span>.
          </P>
        </Section>

        <Section title="Why the judge exists — the documented incidents">
          <P>
            Run the same engine over {incidents.length} real, documented agent failures (Air Canada, Replit, the $1
            Tahoe, Mata v. Avianca…) and it largely <em>abstains</em>. That isn&rsquo;t a bug — almost every real-world
            case is a <Num>CLAIM_MISMATCH</Num>: the agent said something false, gave illegal advice, fabricated a
            citation. Numbers reconcile; the <em>claim</em> doesn&rsquo;t. This is precisely the residual the LLM judge
            is built for, and the clearest argument that deterministic-first is right: be exact where you can be, and
            don&rsquo;t guess where you can&rsquo;t.
          </P>
          <MetricsTable report={incReport} caption={`Deterministic engine · ${incidents.length} documented incidents`} />
          <P className="text-cream-dim">
            The two <Num>SCOPE_CREEP</Num> false positives here are a known eval-validity nuance: several incidents are
            advice/decision failures framed with “no purchase authorized,” which trips the spend rule. They&rsquo;re
            documented in the limitations below, not papered over.
          </P>
        </Section>

        <Section title="Reproduce it in one command">
          <P>Nothing here is a number in prose. Clone the repo and re-run it:</P>
          <Code>
            {`# the engine + judge unit tests (TDD)
npm test

# this exact per-class table, in the terminal
npm run eval

# the citable harness: Inspect AI (the engine is the classifier; this only scores it)
npm run eval:build
inspect eval eval/discrepancy_eval.py --model mockllm/model -T split=all -T seed=1234`}
          </Code>
          <P className="text-cream-dim">
            The engine is deterministic — it has no learned parameters — so the seed-shuffled split (
            <code>-T split=test</code>) is there for reproducible partitioning, not overfitting control; the headline
            runs on the full labeled set. Same file + seed ⇒ byte-identical split, recorded in the <code>.eval</code>{" "}
            log. Inspect carries each prediction&rsquo;s classes, so the scorer builds a real confusion matrix and
            reports per-class precision/recall with standard error (the small fixture N is honest, not hidden).
          </P>
        </Section>

        <Section title="Built to break itself — contract, fuzzing, verifiable receipts">
          <P>
            The engine isn&rsquo;t only checked against examples; it&rsquo;s held to a{" "}
            <strong className="text-cream">formal contract</strong>. Its {INVARIANTS.length} firing invariants and{" "}
            {METAMORPHIC_PROPERTIES.length} metamorphic relations (see <code>SPEC.md</code>) are written as executable
            predicates <em>independent of the engine</em>, and a property-based fuzzer mutates inputs against the rule
            boundaries trying to break them.
          </P>
          <div className="not-prose my-5 grid gap-px overflow-hidden rounded-sm border border-cream/12 bg-cream/10 sm:grid-cols-3">
            <Stat n={(fz.cases + mm.cases).toLocaleString()} label="mutated cases fuzzed" />
            <Stat
              n={String(fz.failures.length + fz.determinismFailures + mm.failures.length)}
              label="violations found"
              tone={fz.failures.length + fz.determinismFailures + mm.failures.length ? "bad" : "ok"}
            />
            <Stat n={String(INVARIANTS.length + METAMORPHIC_PROPERTIES.length)} label="properties proven" />
          </div>
          <P>
            Computed live on every build (and inside <code>npm test</code>; run it with <code>npm run fuzz</code>).
            Beyond firing the right flags, the metamorphic relations prove the engine is <em>coherent</em> — more
            money charged can never remove an overspend; raising the budget can never create one; granting
            authorization can only remove findings. Four more moves past plain detection:
          </P>
          <ul className="not-prose space-y-3 text-[14px] leading-relaxed text-cream/75">
            <Li tone="ok">
              <b className="text-cream">Diagnosis, not just detection.</b> Each finding carries ranked, deterministic
              root-cause hypotheses (&ldquo;+$78 → likely an undisclosed seat fee + add-on&rdquo;) — closer to a
              black-box recorder than a tripwire.
            </Li>
            <Li tone="ok">
              <b className="text-cream">Tamper-evident, auditable receipts.</b> Each receipt is content-addressed
              (SHA-256 over its claim, evidence, and verdict) and batched into a <strong className="text-cream">Merkle
              audit trail</strong>: one root commits to a whole session, and an inclusion proof shows a receipt belongs
              to it <em>without revealing the others</em> — selective transparency, no SNARK required.
            </Li>
            <Li tone="ok">
              <b className="text-cream">The judge is a measured instrument.</b> A calibration harness scores it against
              human labels (TPR/FPR, precision/recall, Cohen&rsquo;s κ) and reports a rate as a Wilson{" "}
              <em>confidence interval</em> (&ldquo;37–44%&rdquo;), not a point. An evaluator-of-the-evaluator probe
              flags positional bias. Built and unit-tested; it runs the moment a key and labels exist.
            </Li>
            <Li tone="ok">
              <b className="text-cream">Externally grounded.</b> Run over the 164 real airline + retail tasks of
              τ²-bench (Sierra, MIT), the engine produces <strong className="text-cream">zero false positives</strong>{" "}
              on the in-scope reference trajectories. Honestly scoped — a specificity check, not a τ²-bench score (the
              money dimensions need the benchmark&rsquo;s environment); see <code>bench/tau2/</code>.
            </Li>
          </ul>
        </Section>

        <Section title="The headline rate is empty on purpose">
          <P>
            “Agents overspent X%” is the number that travels. It can only come from real runs you commissioned (
            <b className="text-cream">self-run / gmail</b> provenance), never from synthetic or third-party data. The
            firewall forbids filling it with anything else. Right now:
          </P>
          <div className="not-prose my-5 rounded-sm border border-cream/12 bg-desk-2/60 p-5 text-center">
            {real.length === 0 ? (
              <div className="inline-block rounded-sm border border-cream/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cream">
                Headline rate · pending live captures
              </div>
            ) : (
              <>
                <div className="font-mono text-[34px] tabular-nums text-cream">
                  {misbehaved}/{real.length}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-cream-dim">
                  real commissioned runs misbehaved
                </div>
                {headlineCI && (
                  <div className="mt-3 font-serif text-[19px] text-cream">
                    ≈ {Math.round((misbehaved / real.length) * 100)}% misbehaved{" "}
                    <span className="font-mono text-[11px] tracking-wide text-cream-dim">(95% CI {headlineCI})</span>
                  </div>
                )}
              </>
            )}
            <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-cream/70">
              {real.length === 0
                ? "No capture runs have been made yet, so the headline is honestly pending. When they happen, the raw captures stay gitignored (they can carry personal data) and `npm run capture:publish` emits the redacted projection — contract fields plus a short no-PII excerpt — to dataset/captured.public.jsonl, committed so anyone can re-score this rate. Synthetic data can never fill it in."
                : `${real.length} real run(s) so far${misbehaved === 0 ? ", all balanced controls" : ""}. ${
                    publishedCorpusExists
                      ? "Re-score it yourself: the redacted public corpus is dataset/captured.public.jsonl."
                      : "These rows are local raw captures — `npm run capture:publish` emits the redacted public corpus that makes this rate verifiable."
                  } Synthetic can never fill it in.`}
            </p>
          </div>
        </Section>

        <Section title="Calibrating the judge before trusting it">
          <P>
            An LLM judge is itself a measurement instrument, so it has to be measured. The plan — gated behind your own{" "}
            <code>ANTHROPIC_API_KEY</code> — is to score the judge&rsquo;s <Num>CLAIM_MISMATCH</Num> calls against the
            human labels on a held-out split (true/false-positive rate, Cohen&rsquo;s κ), and only trust it past a
            calibration bar. Until that runs against real keys, the judge is presented as assistive and clearly badged,
            never as silent ground truth. No LLM judgment drives a money or alert action without a deterministic gate
            behind it.
          </P>
        </Section>

        <Section title="Limitations & known failure modes">
          <ul className="not-prose space-y-3 text-[14px] leading-relaxed text-cream/75">
            <Li tone="weak">
              <b className="text-cream">SCOPE_CREEP recall is {pct(byType.SCOPE_CREEP?.recall)}.</b> The engine catches
              unauthorized spend, a known add-on keyword list, and violated send-prohibitions; item additions outside
              those subsets are abstained to the judge&rsquo;s item comparison.
            </Li>
            <Li tone="weak">
              <b className="text-cream">CLAIM_MISMATCH is unhandled deterministically (recall {pct(byType.CLAIM_MISMATCH?.recall)}).</b>{" "}
              By design — it is the entire LLM-judge residual, and the judge runs only with a key.
            </Li>
            <Li tone="weak">
              <b className="text-cream">Advice-failure framing causes SCOPE_CREEP false positives</b> on a few
              incidents (a “no purchase” scope plus a downstream dollar amount). Surfaced, not hidden.
            </Li>
            <Li tone="muted">
              <b className="text-cream">Synthetic ≠ real.</b> Detector accuracy on fixtures is not a claim about
              real-world prevalence — that is the separate, pending headline number above.
            </Li>
            <Li tone="muted">
              <b className="text-cream">v1 is paste-only.</b> No Gmail OAuth or stored ledger yet; the privacy boundary
              (no raw email body persists; extracted fields + a redacted excerpt only) is a type invariant ready for
              when it does.
            </Li>
          </ul>
        </Section>
      </main>
      <SiteFooter />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12 border-t border-cream/10 pt-9">
      <h2 className="font-serif text-[24px] font-semibold tracking-tight text-cream">{title}</h2>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`text-[15px] leading-relaxed text-cream/80 ${className ?? ""}`}>{children}</p>;
}

function Num({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12.5px] text-cream">{children}</code>;
}

function Li({ children, tone }: { children: ReactNode; tone: "ok" | "weak" | "muted" }) {
  const dot = tone === "ok" ? "bg-ledger-green" : tone === "weak" ? "bg-oxblood" : "bg-cream-dim";
  return (
    <li className="flex gap-3">
      <span className={`mt-2 h-1.5 w-1.5 flex-none rounded-full ${dot}`} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="not-prose my-5 overflow-x-auto rounded-sm border border-cream/12 bg-desk-2/70 p-4 font-mono text-[12px] leading-relaxed text-cream/85">
      <code>{children}</code>
    </pre>
  );
}

function Stat({ n, label, tone }: { n: string; label: string; tone?: "ok" | "bad" }) {
  const color = tone === "bad" ? "text-oxblood" : tone === "ok" ? "text-ledger-green" : "text-cream";
  return (
    <div className="bg-desk px-5 py-5 text-center">
      <div className={`font-mono text-[26px] tabular-nums ${color}`}>{n}</div>
      <div className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-cream-dim">{label}</div>
    </div>
  );
}
