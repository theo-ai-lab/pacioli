import styles from "./SiteChrome.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span>Pacioli · {new Date().getFullYear()}</span>
      <span className={styles.lat}>
        “Particularis de Computis et Scripturis,” after Luca Pacioli · Venezia · MCDXCIV
      </span>
      <span>Every action, entered twice.</span>
    </footer>
  );
}
