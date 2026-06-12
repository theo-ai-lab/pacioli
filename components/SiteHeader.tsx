import Link from "next/link";
import styles from "./SiteChrome.module.css";

export function SiteHeader() {
  return (
    <header className={styles.masthead}>
      <Link href="/" className={styles.brand} aria-label="Pacioli — home">
        <span className={styles.monogram} aria-hidden="true" />
        <span className={styles.wordmark}>
          <span className={styles.title}>Pacioli</span>
          <span className={styles.tag}>Double-entry bookkeeping for AI agents</span>
        </span>
      </Link>
      <nav className={styles.nav} aria-label="Primary">
        <Link href="/">Demo</Link>
        <Link href="/methods">Methods</Link>
        <Link href="/ledger">Ledger Report</Link>
      </nav>
    </header>
  );
}
