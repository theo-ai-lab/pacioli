import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { DemoConsole } from "@/components/DemoConsole";
import { WeeklyClose } from "@/components/WeeklyClose";

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1120px] px-7">
        {/* hero */}
        <section className="mx-auto max-w-3xl pt-16 pb-10 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cream-dim">
            The receipt for what your agent did
          </p>
          <h1 className="mt-5 font-serif text-[clamp(34px,6vw,60px)] font-medium leading-[1.05] tracking-tight text-cream">
            Did your AI actually
            <br /> do what it said?
          </h1>
          <p className="mt-6 font-serif text-[clamp(16px,2.4vw,20px)] italic leading-relaxed text-cream/80">
            Agents book, buy, and subscribe on your behalf — then report it went fine.{" "}
            <span className="font-semibold not-italic text-cream">Pacioli keeps the books.</span> Every
            action is entered twice — what the agent <span className="not-italic text-cream">claimed</span>{" "}
            beside what the evidence <span className="not-italic text-cream">shows</span> — and prints a
            receipt when they don&rsquo;t reconcile.
          </p>
          <div className="mx-auto mt-7 h-px w-14 bg-[linear-gradient(90deg,transparent,var(--color-cream-dim),transparent)]" />
          <p className="mt-6 font-mono text-[12px] leading-relaxed text-cream-dim">
            Spend trackers show you what was charged. Pacioli proves whether your agent told you the truth.
          </p>
        </section>

        {/* the zero-setup demo */}
        <section aria-label="Receipt demo" className="pt-4 pb-6">
          <DemoConsole />
        </section>

        {/* the weekly close — the recurring digest */}
        <section className="mt-16 grid items-center gap-10 border-t border-cream/10 pt-12 lg:grid-cols-[1fr_minmax(0,384px)]">
          <div className="max-w-md">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cream-dim">The Weekly Close</p>
            <h2 className="mt-3 font-serif text-[clamp(24px,3.5vw,32px)] font-medium leading-tight text-cream">
              A week of agent activity, reconciled.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-cream/75">
              Individual receipts are the entries; the Weekly Close is the digest — every action your agents took,
              how much moved, and the handful that need your eyes. Here it is over the demo scenarios, computed by
              the same engine. Sign off to close the books.
            </p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <WeeklyClose />
          </div>
        </section>

        {/* three pillars → routes to the rigor and the evidence */}
        <section className="mt-16 grid gap-px overflow-hidden rounded-sm border border-cream/10 bg-cream/10 sm:grid-cols-3">
          <Pillar
            kicker="Deterministic-first"
            title="Rules before the model"
            body="Overspend, unauthorized recurrence, and scope creep are exact, auditable rules — run right in your browser. The LLM judge only touches the fuzzy residual, and every judgment is badged."
          />
          <Pillar
            kicker="Measured, not claimed"
            title="A per-class eval, reproducible"
            body="The engine is scored per class against a labeled dataset — precision and recall, honest weak spots included. Run it yourself in one command."
            href="/methods"
            cta="See the methods →"
          />
          <Pillar
            kicker="Not hypothetical"
            title="Real agent failures"
            body="Documented, source-cited cases — Air Canada, Replit, a $1 Tahoe — rendered as receipts. The harm is real; the books didn't balance."
            href="/ledger"
            cta="Open the ledger →"
          />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Pillar({
  kicker,
  title,
  body,
  href,
  cta,
}: {
  kicker: string;
  title: string;
  body: string;
  href?: string;
  cta?: string;
}) {
  return (
    <div className="bg-desk px-6 py-7">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cream-dim">{kicker}</p>
      <h2 className="mt-2 font-serif text-[19px] font-semibold text-cream">{title}</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-cream/70">{body}</p>
      {href && cta && (
        <Link
          href={href}
          className="mt-3 inline-block font-mono text-[11px] uppercase tracking-wide text-cream underline-offset-4 hover:underline"
        >
          {cta}
        </Link>
      )}
    </div>
  );
}
