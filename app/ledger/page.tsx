import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { IncidentCard } from "@/components/IncidentCard";
import { SessionLedger } from "@/components/SessionLedger";
import { loadIncidents } from "@/lib/engine/dataset";
import type { GroundTruthSample } from "@/lib/engine/types";

export const metadata: Metadata = {
  title: "Your Ledger · The Ledger Report",
  description:
    "Forward a confirmation and watch it reconcile into your own receipt ledger — then the Ledger Report: documented, source-cited cases where an AI agent's claim diverged from what actually happened (Air Canada, Replit, the $1 Tahoe, Mata v. Avianca), rendered as receipts.",
};

// Curation policy: resolved/adjudicated cases are featured; cases still in active
// litigation are walled off and framed as allegations; one consumer-complaint pattern
// (defamation-adjacent if stated as fact) is held back entirely.
const RESOLVED_IDS = ["cap-201", "cap-305", "cap-306", "cap-509", "cap-504", "cap-505", "cap-502", "cap-501", "cap-508", "cap-506", "cap-503"];
const ALLEGED_IDS = ["cap-507", "cap-510", "cap-511"];

const ROT = [-1.1, 0.7, -0.6, 1, -0.8, 0.5, -1, 0.8, -0.5, 0.9, -0.7];

export default function LedgerPage() {
  const byId = new Map(loadIncidents().map((s) => [s.id, s]));
  const pick = (ids: string[]): GroundTruthSample[] => ids.map((id) => byId.get(id)).filter(Boolean) as GroundTruthSample[];
  const resolved = pick(RESOLVED_IDS);
  const alleged = pick(ALLEGED_IDS);
  const total = byId.size;
  const shown = resolved.length + alleged.length;
  const heldBack = total - shown;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1180px] px-7 pt-14 pb-4">
        {/* The live product loop: forward a confirmation → reconcile → review your own receipt ledger. */}
        <SessionLedger />

        <div className="mx-auto mt-16 max-w-2xl text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cream-dim">The Ledger Report</p>
          <h1 className="mt-4 font-serif text-[clamp(30px,5vw,48px)] font-medium leading-[1.06] tracking-tight text-cream">
            Real agents. Real failures.
            <br />
            The books didn&rsquo;t balance.
          </h1>
          <p className="mt-5 font-serif text-[18px] italic leading-relaxed text-cream/80">
            Documented cases where an AI agent&rsquo;s <span className="not-italic text-cream">claim</span> diverged
            from what the evidence <span className="not-italic text-cream">showed</span> — entered twice, and
            reconciled against a primary or reputable source. Every card links out. Cases still before a court are
            labeled and kept separate.
          </p>
        </div>

        <section className="mt-12 columns-1 gap-6 sm:columns-2 lg:columns-3 [&>*]:mb-6 [&>*]:break-inside-avoid">
          {resolved.map((s, i) => (
            <IncidentCard key={s.id} sample={s} mode="documented" rotateDeg={ROT[i % ROT.length]} />
          ))}
        </section>

        <section className="mt-16 border-t border-cream/10 pt-10">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-serif text-[26px] font-semibold tracking-tight text-cream">
              Alleged — in active litigation
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-cream/70">
              These are serious, widely-reported claims that have <strong className="text-cream">not</strong> been
              proven. They sit in pending suits where the companies dispute the allegations. They&rsquo;re included for
              completeness and labeled accordingly — not asserted as fact.
            </p>
          </div>
          <div className="mx-auto mt-9 grid max-w-[820px] grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {alleged.map((s, i) => (
              <IncidentCard key={s.id} sample={s} mode="alleged" rotateDeg={ROT[(i + 2) % ROT.length]} />
            ))}
          </div>
        </section>

        {heldBack > 0 && (
          <p className="mx-auto mt-12 max-w-2xl text-center font-mono text-[11px] leading-relaxed text-cream-dim">
            {shown} of {total} documented cases are shown here. {heldBack} consumer-complaint pattern is held back
            from this public gallery pending stronger primary sourcing; the eval still scores the full set (see{" "}
            <a href="/methods" className="border-b border-cream/25 hover:text-cream">
              Methods
            </a>
            ).
          </p>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
