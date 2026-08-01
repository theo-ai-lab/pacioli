/**
 * Pacioli — run the ledger tamper drill.  `npm run drill:tamper -- [<db>] [--report <file>]`
 *
 * A scripted adversary mutates a COPY of a persisted ledger one tamper class at a time, with targets
 * drawn from a seeded generator, and the verifier has to catch every one. Exits non-zero if ANY
 * in-model tamper escapes — so an escape reddens CI instead of sitting in a report nobody re-runs.
 *
 * The ledger passed in is never written to; every case runs against a copy in a temp directory.
 *
 * Exit codes:  0 = every in-model tamper was caught   1 = an escape (or the control failed)   2 = bad usage
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTamperDrill, renderDrillReport, TAMPER_CLASSES } from "./tamper-drill";

const DEFAULT_LEDGER = "dataset/reference-ledger.db";
const DEFAULT_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const USAGE = `pacioli drill:tamper — prove the ledger's tamper-evidence against a scripted adversary

  npm run drill:tamper -- [path/to/receipts.db] [--report <file.md>] [--seeds 1,2,3] [--json]

Defaults to ${DEFAULT_LEDGER} (the store CI audits on every push). The target is copied, never written to.

Exit codes:  0 = every in-model tamper was caught   1 = an escape   2 = bad usage`;

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const reportPath = flag("--report");
  const seedArg = flag("--seeds");
  const seeds = seedArg ? seedArg.split(",").map((s) => Number(s.trim())) : DEFAULT_SEEDS;
  if (seeds.some((s) => !Number.isFinite(s))) {
    console.error(`bad --seeds ${JSON.stringify(seedArg)} — expected a comma-separated list of numbers`);
    return 2;
  }
  const consumed = new Set([reportPath, seedArg]);
  const ledger = args.find((a) => !a.startsWith("-") && !consumed.has(a)) ?? DEFAULT_LEDGER;

  const report = await runTamperDrill({
    ledger,
    workdir: mkdtempSync(join(tmpdir(), "pacioli-drill-")),
    seeds,
  });

  if (reportPath) {
    writeFileSync(reportPath, renderDrillReport(report, ledger));
    console.log(`wrote ${reportPath}`);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  const inModel = report.classes.filter((c) => c.model === "in-model");
  const attempted = inModel.reduce((n, c) => n + c.attempted, 0);
  const caught = inModel.reduce((n, c) => n + c.asExpected, 0);
  console.log(`PACIOLI — tamper drill against a copy of ${ledger}`);
  console.log(
    `  ${TAMPER_CLASSES.length} classes · seeds ${seeds.join(",")} · ${attempted} in-model cases, ${report.skipped} not applicable`,
  );
  console.log(
    `  control: an untampered copy ${report.control.ok ? "VERIFIES" : `FAILED (${report.control.faults.join(", ")})`}`,
  );
  for (const c of inModel) {
    const mark = c.attempted === 0 ? "·" : c.asExpected === c.attempted ? "✓" : "✗";
    console.log(
      `  ${mark} ${c.id.padEnd(38)} ${String(c.asExpected).padStart(3)}/${String(c.attempted).padEnd(3)} ${c.faultKinds.join(", ")}`,
    );
  }
  for (const c of report.classes.filter((x) => x.model === "boundary")) {
    console.log(`  ⌐ ${c.id.padEnd(38)} ${String(c.asExpected).padStart(3)}/${String(c.attempted).padEnd(3)} pinned: still verifies`);
  }

  if (report.ok) {
    console.log(`DRILLED — ${caught}/${attempted} tampers caught and located, and the untampered control still verifies.`);
    return 0;
  }
  console.error(`FAILED — the ledger's tamper-evidence has a hole.`);
  if (!report.control.ok) console.error(`  the NEGATIVE CONTROL failed: an untampered ledger does not verify (${report.control.faults.join(", ")})`);
  for (const e of report.escapes) console.error(`  [escaped] ${e.classId} (seed ${e.seed}): ${e.what}`);
  for (const p of report.pinBreaks) console.error(`  [pin moved] ${p.classId} (seed ${p.seed}): ${p.what} → ${p.faultKinds.join(", ")}`);
  for (const u of report.unlocated) console.error(`  [unlocated] ${u} failed verification without naming a fault`);
  console.error(`\nAn escaped tamper is a receipt an operator would be shown as verified. Fix the verifier, not the drill.`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FAILED — ${(err as Error).message}`);
    process.exit(1);
  },
);
