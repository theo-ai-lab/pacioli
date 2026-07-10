import { diff } from "@pacioli-app/engine";
import { EXAMPLES } from "@/lib/examples";
import styles from "./WeeklyClose.module.css";

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const titleOf = (e: (typeof EXAMPLES)[number]): string =>
  e.evidence.items[0] ?? e.claim.task.replace(/[."]+$/, "").slice(0, 28);

/**
 * The recurring "close the books" digest — the on-thesis kernel of observability, driven by the engine
 * over the demo scenarios as a single "week" of agent activity. Server component; no persistence.
 */
export function WeeklyClose() {
  const entries = EXAMPLES.map((ex) => ({ ex, verdict: diff({ claim: ex.claim, evidence: ex.evidence }) }));
  const total = entries.length;
  const balanced = entries.filter((e) => e.verdict.balanced).length;
  const flagged = entries.filter((e) => !e.verdict.balanced);
  const moved = entries.reduce((s, e) => s + (typeof e.ex.evidence.amountUsd === "number" ? e.ex.evidence.amountUsd : 0), 0);
  const reconciledPct = total ? Math.round((balanced / total) * 100) : 0;

  return (
    <article className={styles.zclose} aria-label="Weekly Close — Z-Report">
      <div className={`${styles.perf} ${styles.perfTop}`} aria-hidden="true" />
      <div className={styles.paper}>
        <div className={styles.head}>
          <div className={styles.k}>— Weekly Close —</div>
          <div className={styles.t}>Z-Report</div>
          <div className={styles.d}>
            {total} agent actions · {EXAMPLES.length} scenarios
          </div>
        </div>

        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.n}>{total}</div>
            <div className={styles.l}>Actions</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.n} ${styles.nGreen}`}>{balanced}</div>
            <div className={styles.l}>Balanced</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.n} ${styles.nRed}`}>{flagged.length}</div>
            <div className={styles.l}>Need your eyes</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.n}>{usd(moved)}</div>
            <div className={styles.l}>Moved</div>
          </div>
          <div className={`${styles.stat} ${styles.wide}`}>
            <div className={`${styles.n} ${reconciledPct >= 80 ? styles.nGreen : ""}`}>{reconciledPct}%</div>
            <div className={styles.l}>Reconciled this week</div>
          </div>
        </div>

        {flagged.length > 0 && (
          <div className={styles.flags}>
            <div className={styles.flagsHead}>
              ⚑ {flagged.length} {flagged.length === 1 ? "entry doesn't" : "entries don't"} reconcile
            </div>
            {flagged.map((e) => {
              const top = e.verdict.findings[0];
              const delta = typeof e.verdict.deltaUsd === "number" && e.verdict.deltaUsd > 0 ? e.verdict.deltaUsd : null;
              return (
                <div className={styles.flag} key={e.ex.id}>
                  <div className={styles.nm}>
                    {titleOf(e.ex)}
                    <small>{top?.note ?? top?.type}</small>
                  </div>
                  <div className={styles.amt}>
                    {delta ? `+${usd(delta)}` : (top?.type ?? "flag").replace(/_/g, " ").toLowerCase()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.sign}>
          <div>
            <div className={styles.sig}>reconcile</div>
            <div className={styles.sigL}>Sign off to close the books</div>
          </div>
          <div className={styles.code}>Z · WK23</div>
        </div>
      </div>
      <div className={`${styles.perf} ${styles.perfBottom}`} aria-hidden="true" />
    </article>
  );
}
