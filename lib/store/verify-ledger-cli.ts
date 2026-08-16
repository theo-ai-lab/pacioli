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
import { readFileSync } from "node:fs";
import { verifyLedger } from "./verify-ledger";
import { parseAnchor, type LedgerAnchor } from "./ledger-anchor";

const USAGE = `pacioli verify:ledger — audit a persisted receipt store

  npm run verify:ledger -- <path/to/receipts.db> [--anchor <anchor.json>] [--json]

Without --anchor this proves the file is INTERNALLY CONSISTENT. That is not the same as
proving it is the ledger you committed to: an adversary with write access can edit a
receipt and re-derive every leaf, link and root, and the result passes this walk. Only a
commitment taken earlier and kept where that adversary cannot reach it detects the swap.
Take one with 'npm run anchor:ledger -- <db> > anchor.json' and keep it off the box.

Exit codes:  0 = the ledger verifies   1 = tampering or an unverifiable store   2 = bad usage`;

/**
 * Read `--flag value` or `--flag=value`.
 *
 * Returns the flag's presence separately from its value, because the two used to be
 * conflated: `--anchor` as the LAST argument yielded `undefined`, which read as "no
 * anchor requested" and produced a silent unanchored PASS at exit 0. On a
 * security-critical flag, a malformed invocation must fail, never downgrade. The
 * equals form was not parsed at all and degraded the same way.
 */
function option(args: string[], flag: string): { present: boolean; value?: string } {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return { present: true, value: eq.slice(flag.length + 1) };
  const i = args.indexOf(flag);
  if (i < 0) return { present: false };
  return { present: true, value: args[i + 1] };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const json = args.includes("--json");
  const anchorOpt = option(args, "--anchor");
  const anchorPath = anchorOpt.value;
  // The anchor path is a value, not a target — without this the db would be read from it.
  const path = args.find((a) => !a.startsWith("-") && a !== anchorPath);
  // --help means "explain yourself", never "the ledger verifies". Returning 0 here
  // handed a CI step a green gate on zero evidence when a stray flag crept onto the
  // line, and exit 0 is documented as "the ledger verifies".
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 2;
  }
  if (!path) {
    console.log(USAGE);
    return 2;
  }

  let anchor: LedgerAnchor | undefined;
  if (anchorOpt.present) {
    if (anchorPath === undefined || anchorPath === "" || anchorPath.startsWith("-")) {
      console.error(`FAILED — --anchor needs a file path.`);
      return 2;
    }
    try {
      anchor = parseAnchor(readFileSync(anchorPath, "utf8"));
    } catch (err) {
      // Fail closed: an unreadable anchor must never degrade into an unanchored pass, which is
      // the one outcome an attacker who can delete the anchor file would be hoping for.
      console.error(`FAILED — could not read the anchor at ${anchorPath}: ${(err as Error).message}`);
      return 1;
    }
  }

  const report = await verifyLedger(path, { anchor });

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
    // Two different claims must not share one word. Without an anchor this walk cannot rule out a
    // whole-ledger re-seal, so it does not get to say the word that implies it did.
    if (report.anchored) {
      console.log(
        `VERIFIED — every receipt hashes to its committed leaf, every link holds, and the head and` +
          ` root match the anchor taken at ${anchor!.sealedAt}.`,
      );
    } else {
      console.log(
        `SELF-CONSISTENT — every receipt hashes to its committed leaf and every link holds.\n` +
          `  NOT ANCHORED: this does not rule out a whole-ledger re-seal, in which an adversary with` +
          ` write access\n  edits a receipt and re-derives every leaf, link and root. Such a file` +
          ` passes this walk.\n  Compare against a commitment kept off this machine:` +
          ` --anchor <anchor.json>`,
      );
    }
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
