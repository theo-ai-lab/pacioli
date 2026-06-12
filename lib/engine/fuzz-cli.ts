/**
 * Pacioli — fuzzer CLI.  `npm run fuzz [cases] [seed]`
 * Exits non-zero on any invariant violation or determinism failure (CI-gateable).
 */

import { fuzz } from "./fuzz";

const cases = Number(process.argv[2] ?? 50_000);
const seed = Number(process.argv[3] ?? 1234);

const res = fuzz(cases, seed);

console.log(`PACIOLI — property-based invariant fuzz`);
console.log(`  ${res.cases.toLocaleString()} mutated cases · seed ${res.seed}`);
console.log(`  determinism failures: ${res.determinismFailures}`);
console.log(`  invariant violations: ${res.failures.length}`);

if (res.failures.length || res.determinismFailures) {
  console.log("\nFIRST FAILURES:");
  console.log(JSON.stringify(res.failures.slice(0, 3), null, 2));
  process.exit(1);
}
console.log("  ✓ every engine invariant held under fuzzing");
