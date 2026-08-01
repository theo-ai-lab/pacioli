/**
 * Pacioli — audit a persisted receipt store.  `npm run verify:ledger -- <db> [--json]`
 *
 * Walks the durable ledger's hash chain and per-scope Merkle commitments and EXITS NON-ZERO at the
 * first place the record stops being self-consistent, naming the scope, the sequence number and the
 * receipt id. This is the check an operator (or a regulator) runs against the sqlite file itself, with
 * no trust in the process that wrote it — and the check CI runs against a committed reference store on
 * every push, so the tamper-evidence claim is re-proven continuously rather than asserted once.
 *
 * Read-only: the database is opened read-only and nothing here writes.
 */
import { verifyLedger } from "./verify-ledger";

const USAGE = `pacioli verify:ledger — audit a persisted receipt store

  npm run verify:ledger -- <path/to/receipts.db> [--json]

Exit codes:  0 = the ledger verifies   1 = tampering or an unverifiable store   2 = bad usage`;

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const json = args.includes("--json");
  const path = args.find((a) => !a.startsWith("-"));
  if (!path || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return path ? 0 : 2;
  }

  const report = await verifyLedger(path);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(`PACIOLI — verifying the persisted ledger at ${report.path}`);
  if (report.ok) {
    console.log(`  ${report.receipts} receipts, chain intact from genesis to head.`);
    for (const s of report.scopes) {
      const name = s.scope === "" ? "whole store" : `session ${JSON.stringify(s.scope)}`;
      console.log(
        `  ${name.padEnd(28)} ${String(s.receipts).padStart(6)} receipts · root ${s.root.slice(0, 16)}… (sealed over ${s.rootCount})`,
      );
    }
    console.log("VERIFIED — every receipt hashes to its committed leaf and every link holds.");
    return 0;
  }

  console.error(`FAILED — this ledger does not verify.`);
  for (const f of report.faults) console.error(`  [${f.kind}] ${f.detail}`);
  console.error(
    `\nA receipt store is only evidence while it verifies. Restore from a known-good copy, or treat` +
      ` every receipt at or after the fault as unattested.`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FAILED — ${(err as Error).message}`);
    process.exit(1);
  },
);
