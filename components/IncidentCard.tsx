import type { CSSProperties } from "react";
import type { GroundTruthSample } from "@pacioli-app/engine";
import styles from "./IncidentCard.module.css";

const compactUsd = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n.toLocaleString("en-US")}`;
};

const firstUrl = (s?: string): string | null => s?.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,;]+$/, "") ?? null;

export function IncidentCard({
  sample,
  mode = "documented",
  rotateDeg = 0,
}: {
  sample: GroundTruthSample;
  mode?: "documented" | "alleged";
  rotateDeg?: number;
}) {
  const { claim, evidence } = sample.input;
  const alleged = mode === "alleged";
  const source = firstUrl(sample.meta.notes);
  const types = Array.from(new Set(sample.target.findings.map((f) => f.type)));

  return (
    <article
      className={styles.card}
      style={{ "--rot": `${rotateDeg}deg` } as CSSProperties}
      aria-label={`${alleged ? "Alleged" : "Documented"} incident: ${evidence.merchant}${
        alleged ? " — in active litigation" : ""
      }`}
    >
      <div className={`${styles.perf} ${styles.perfTop}`} aria-hidden="true" />
      <div className={styles.paper}>
        <div className={`${styles.stamp} ${alleged ? styles.stampAlleged : styles.stampOut}`} aria-hidden="true">
          <b>{alleged ? "ALLEGED" : "OUT OF"}</b>
          {!alleged && <b>BALANCE</b>}
        </div>

        <div className={styles.merchant}>{evidence.merchant}</div>
        <div className={styles.meta}>
          <span className={styles.agent}>{claim.agent}</span>
          {evidence.date && <span>{evidence.date}</span>}
          <span>{sample.meta.provenance.replace("-", " ")}</span>
        </div>

        <div className={styles.block}>
          <div className={styles.label}>Claimed</div>
          <p className={styles.claimText}>&ldquo;{claim.text}&rdquo;</p>
        </div>
        <div className={styles.rule} />
        <div className={styles.block} style={{ marginTop: 0 }}>
          <div className={styles.label}>Actual</div>
          <p className={styles.actualText}>{evidence.excerpt}</p>
        </div>

        <div className={styles.badges}>
          {types.map((t) => (
            <span key={t} className={`${styles.badge} ${alleged ? styles.badgeAlleged : ""}`}>
              {t}
            </span>
          ))}
          {typeof evidence.amountUsd === "number" && evidence.amountUsd > 0 && (
            <span className={`${styles.impact} ${alleged ? styles.impactAlleged : ""}`}>
              {compactUsd(evidence.amountUsd)}
            </span>
          )}
        </div>

        <div className={styles.foot}>
          <span>{alleged ? "Unproven · pending litigation" : "Documented"}</span>
          {source && (
            <a className={styles.src} href={source} target="_blank" rel="noopener noreferrer">
              Source ↗
            </a>
          )}
        </div>
      </div>
      <div className={`${styles.perf} ${styles.perfBottom}`} aria-hidden="true" />
    </article>
  );
}
