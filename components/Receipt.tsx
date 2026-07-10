import type { CSSProperties, ReactNode } from "react";
import type { AgentClaim, Dimension, MerchantEvidence, Verdict } from "@pacioli-app/engine";
import styles from "./Receipt.module.css";

export interface ReceiptProps {
  claim: AgentClaim;
  evidence: MerchantEvidence;
  verdict: Verdict;
  /** Receipt number, e.g. "0042". */
  no?: string;
  /** Short action title; falls back to a derived form of the task. */
  title?: string;
  /** Slight rotation for the "stack of receipts" feel; 0 in single-receipt contexts. */
  rotateDeg?: number;
  /** Short SHA-256 fingerprint — makes the receipt a tamper-evident, content-addressed witness. */
  contentHash?: string;
  /** Top abductive root-cause for the worst finding (diagnosis, not just detection). */
  likelyCause?: string;
}

interface LedgerRow {
  label: string;
  claimed: ReactNode;
  actual: ReactNode;
  flagged: boolean;
  note?: string;
  llmAssisted?: boolean;
}

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DIM_LABEL: Record<Dimension, string> = {
  money: "Money",
  time: "When",
  item: "Item",
  scope: "Scope",
  quantity: "Qty",
  recurrence: "Recurring",
};

function deriveTitle(claim: AgentClaim, evidence: MerchantEvidence, explicit?: string): string {
  if (explicit) return explicit;
  if (evidence.items.length > 0) return evidence.items[0];
  const t = claim.task.replace(/[."]+$/, "");
  if (t.length <= 42) return t;
  const cut = t.slice(0, 42);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 20 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function buildRows(claim: AgentClaim, evidence: MerchantEvidence, verdict: Verdict): LedgerRow[] {
  const a = claim.authorized ?? {};
  const find = (t: string) => verdict.findings.find((f) => f.type === t);
  const rows: LedgerRow[] = [];

  // Scope / what
  const scopeFinding = find("SCOPE_CREEP");
  const scopeActual: string =
    evidence.items.length > 0
      ? evidence.items.join(", ")
      : a.mayPurchase === false && typeof evidence.amountUsd === "number" && evidence.amountUsd > 0
        ? "purchase made"
        : "as authorized";
  rows.push({
    label: "Scope",
    claimed: a.scope ?? (a.mayPurchase === false ? "research only — no purchase" : claim.task),
    actual: scopeActual,
    flagged: Boolean(scopeFinding),
    note: scopeFinding?.note,
  });

  // Money
  const overspend = find("OVERSPEND");
  const hasAmount = typeof evidence.amountUsd === "number";
  if (hasAmount || typeof a.budgetUsd === "number") {
    const claimedMoney =
      typeof a.budgetUsd === "number" && a.budgetUsd > 0
        ? `within ${usd(a.budgetUsd)}`
        : a.mayPurchase === false
          ? "$0 — no purchase"
          : "—";
    rows.push({
      label: "Money",
      claimed: claimedMoney,
      actual: hasAmount ? (
        <span className={overspend ? `${styles.money} ${styles.moneyOver}` : styles.money}>
          {usd(evidence.amountUsd as number)}
        </span>
      ) : (
        "—"
      ),
      flagged: Boolean(overspend),
      note: overspend?.note,
    });
  }

  // Recurrence
  if (evidence.recurring) {
    const recur = find("UNAUTH_RECURRENCE");
    rows.push({
      label: "Recurring",
      claimed: a.mayRecur ? "recurring (authorized)" : "one-time",
      actual: `recurring ${evidence.recurringPeriod ?? "charge"}`,
      flagged: Boolean(recur),
      note: recur?.note,
    });
  }

  // Residual / judge findings (CLAIM_MISMATCH or any llm-assisted) not represented above
  for (const f of verdict.findings) {
    const covered = f.type === "OVERSPEND" || f.type === "SCOPE_CREEP" || f.type === "UNAUTH_RECURRENCE";
    if (covered) continue;
    rows.push({
      label: DIM_LABEL[f.dimension],
      claimed: f.claimedRef,
      actual: f.actualRef,
      flagged: true,
      note: f.note,
      llmAssisted: f.llmAssisted,
    });
  }

  return rows;
}

export function Receipt({
  claim,
  evidence,
  verdict,
  no = "0001",
  title,
  rotateDeg = 0,
  contentHash,
  likelyCause,
}: ReceiptProps) {
  const rows = buildRows(claim, evidence, verdict);
  const balanced = verdict.balanced;
  const discrepancies = verdict.findings.length;
  const dateLabel = evidence.date
    ? new Date(`${evidence.date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "2-digit" })
    : null;

  // Only surface a delta when it's *over* — a negative (under-budget) delta next to
  // "out of balance" misreads; those cases are out of balance on a non-money finding.
  const deltaLabel =
    typeof verdict.deltaUsd === "number" && verdict.deltaUsd > 0 ? `Δ +${usd(verdict.deltaUsd)}` : null;

  const detail = balanced
    ? `${typeof evidence.amountUsd === "number" ? usd(evidence.amountUsd) : "$0.00"} moved · 0 discrepancies · claimed = actual`
    : [deltaLabel, `${discrepancies} discrepanc${discrepancies === 1 ? "y" : "ies"}`].filter(Boolean).join(" · ");

  const route = evidence.merchant.replace(/[^A-Za-z0-9]+/g, "").slice(0, 10).toUpperCase() || "LEDGER";

  return (
    <article
      className={styles.receipt}
      style={{ "--rot": `${rotateDeg}deg` } as CSSProperties}
      aria-label={`Agent action receipt ${no}: ${balanced ? "balances" : "out of balance"}`}
    >
      <div className={`${styles.perf} ${styles.perfTop}`} aria-hidden="true" />
      <div className={styles.paper}>
        <div className={styles.scan} aria-hidden="true" />

        {!balanced && (
          <div className={`${styles.stamp} ${styles.stampOut}`} aria-hidden="true">
            <b>OUT OF</b>
            <b>BALANCE</b>
            <span>reconcile</span>
          </div>
        )}
        {balanced && (
          <div className={`${styles.stamp} ${styles.stampOk}`} aria-hidden="true">
            <b>BALANCED</b>
            <span>reconciled</span>
          </div>
        )}

        <div className={styles.head}>
          <div className={styles.brand}>
            Pacioli<sup className={styles.brandSup}>™</sup>
          </div>
          <div className={styles.sub}>Agent Action Receipt</div>
          <div className={styles.meta}>
            <span>No. {no}</span>
            <span>{dateLabel ?? "—"}</span>
          </div>
          <div className={styles.agent}>{claim.agent}</div>
        </div>

        <div className={styles.title}>{deriveTitle(claim, evidence, title)}</div>
        <div className={styles.ask}>&ldquo;{claim.task}&rdquo;</div>

        <div className={styles.ledger}>
          <div className={`${styles.colHead} ${styles.colHeadClaimed}`}>Claimed</div>
          <div className={styles.spine} />
          <div className={`${styles.colHead} ${styles.colHeadActual}`}>Actual</div>

          {rows.map((row, i) => (
            <div className={styles.row} key={i}>
              <div className={`${styles.cell} ${styles.cellClaimed}`}>{row.claimed}</div>
              <div className={styles.rowLabel}>{row.label}</div>
              <div className={`${styles.cell} ${styles.cellActual} ${row.flagged ? styles.flag : ""}`}>
                <span className={row.flagged ? styles.val : undefined}>{row.actual}</span>
                {row.note && <span className={styles.was}>{row.note}</span>}
                {row.llmAssisted && <span className={styles.was}>LLM-assisted — verify before acting</span>}
              </div>
            </div>
          ))}
        </div>

        <div
          className={`${styles.balance} ${balanced ? styles.balanceOk : styles.balanceOut}`}
          role="status"
          aria-live="polite"
        >
          <div className={styles.mark} aria-hidden="true">
            {balanced ? "✓" : "≠"}
          </div>
          <div>
            <span className={styles.balLab}>{balanced ? "Balances" : "Out of balance"}</span>
            <span className={styles.balDet}>{detail}</span>
          </div>
        </div>

        {!balanced && likelyCause && (
          <div className={styles.cause}>
            <b>Likely cause</b>
            <br />
            {likelyCause}
          </div>
        )}

        <div className={styles.barcode}>
          <div className={styles.bars} aria-hidden="true" />
          <div className={styles.code}>{contentHash ? `sha256 · ${contentHash}` : `PCL · ${no} · ${route} · MMXXVI`}</div>
        </div>
      </div>
      <div className={`${styles.perf} ${styles.perfBottom}`} aria-hidden="true" />
    </article>
  );
}
