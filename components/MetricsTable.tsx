import type { EvalReport } from "@/lib/engine/metrics";

const fmt = (x: number | null): string => (x == null ? "—" : x.toFixed(2));

function tag(recall: number | null, precision: number | null, support: number): { label: string; tone: "ok" | "weak" | "muted" } {
  if (support === 0) return { label: "no labeled positives", tone: "muted" };
  if (recall === 0) return { label: "abstained → LLM judge", tone: "weak" };
  if ((recall ?? 0) >= 0.9 && (precision ?? 0) >= 0.9) return { label: "strong", tone: "ok" };
  if ((recall ?? 0) < 0.5) return { label: "partial — deterministic subset only", tone: "weak" };
  return { label: "good", tone: "ok" };
}

export function MetricsTable({ report, caption }: { report: EvalReport; caption: string }) {
  return (
    <figure className="not-prose my-7">
      <div className="overflow-hidden rounded-sm border border-cream/12">
        <table className="w-full border-collapse font-mono text-[12.5px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="bg-cream/[0.04] text-cream-dim">
              <th scope="col" className="px-4 py-2.5 text-left font-medium tracking-[0.12em] uppercase text-[10px]">
                Class
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium tracking-[0.12em] uppercase text-[10px]">
                Precision
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium tracking-[0.12em] uppercase text-[10px]">
                Recall
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium tracking-[0.12em] uppercase text-[10px]">
                n
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium tracking-[0.12em] uppercase text-[10px]">
                Read
              </th>
            </tr>
          </thead>
          <tbody>
            {report.perClass.map((m) => {
              const t = tag(m.recall, m.precision, m.support);
              const toneCls = t.tone === "ok" ? "text-ledger-green" : t.tone === "weak" ? "text-oxblood" : "text-cream-dim";
              return (
                <tr key={m.type} className="border-t border-cream/8">
                  <th scope="row" className="px-4 py-2.5 text-left font-medium text-cream">
                    {m.type}
                  </th>
                  <td className="px-3 py-2.5 text-right tabular-nums text-cream/85">{fmt(m.precision)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-cream/85">{fmt(m.recall)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-cream-dim">{m.support}</td>
                  <td className={`px-4 py-2.5 text-left text-[11px] ${toneCls}`}>{t.label}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-cream/12 bg-cream/[0.03] text-cream-dim">
              <td colSpan={5} className="px-4 py-2.5 text-[11px]">
                balanced vs out-of-balance classified correctly:{" "}
                <span className="tabular-nums text-cream">
                  {report.balancedCorrect}/{report.balancedTotal}
                </span>
                {report.unscored > 0 && <span> · {report.unscored} unscored (excluded, never counted correct)</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <figcaption className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-cream-dim">{caption}</figcaption>
    </figure>
  );
}
