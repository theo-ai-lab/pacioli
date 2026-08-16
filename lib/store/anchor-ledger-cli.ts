/**
 * Pacioli — take an off-box anchor.  `npm run anchor:ledger -- <db> > anchor.json`
 *
 * Prints a JSON commitment to the whole store's head, root and count. Keep it somewhere the machine
 * holding the database cannot reach: a CI artifact, a signed commit, another host, a printout. An
 * anchor sitting beside the database is taken by whoever takes the database, and then proves nothing.
 *
 * Later: `npm run verify:ledger -- <db> --anchor anchor.json`. That comparison is what detects a
 * whole-ledger re-seal — an adversary editing a receipt and re-deriving every leaf, link and root.
 * The walk alone cannot, because the result is genuinely self-consistent.
 *
 * Refuses to anchor a ledger that does not currently verify: committing to a record that already
 * fails its own walk would freeze an attacker's work into the very thing meant to detect it.
 */
import { writeFileSync } from "node:fs";
import { anchorFromLedger, serializeAnchor } from "./ledger-anchor";

const USAGE = `pacioli anchor:ledger — take an off-box commitment to a ledger

  npm run anchor:ledger -- <path/to/receipts.db> --out anchor.json

Keep the output OFF the machine holding the database. Verify against it with:
  npm run verify:ledger -- <path/to/receipts.db> --anchor anchor.json

Prefer --out to a '>' redirect: 'npm run' prints its own banner to stdout, which lands
in the redirected file and makes the anchor unparseable. (It fails closed if you do —
verify refuses an unreadable anchor rather than falling back to an unanchored pass.)

Exit codes:  0 = anchor written   1 = the ledger does not verify   2 = bad usage`;

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const path = args.find((a) => !a.startsWith("-") && a !== out);
  if (!path || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return path ? 0 : 2;
  }
  if (outIdx >= 0 && (out === undefined || out === "" || out.startsWith("-"))) {
    console.error(`FAILED — --out needs a file path.`);
    return 2;
  }

  const text = serializeAnchor(await anchorFromLedger(path));
  if (out !== undefined) {
    writeFileSync(out, text);
    console.error(`anchored ${path} → ${out}. Keep it off the box holding the database.`);
  } else {
    // stdout carries the anchor and nothing else, so a bare `tsx` invocation can redirect it.
    process.stdout.write(text);
    console.error(`anchored ${path} — keep this off the box holding the database.`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FAILED — ${(err as Error).message}`);
    process.exit(1);
  },
);
