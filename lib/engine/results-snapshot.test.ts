import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderClassTable,
  renderFuzzLine,
  renderTau2Line,
  renderTestsLine,
  replaceBlock,
} from "./results-snapshot";
import type { EvalReport } from "./metrics";
import type { FuzzResult } from "./fuzz";

const report: EvalReport = {
  perClass: [
    { type: "OVERSPEND", tp: 12, fp: 0, fn: 1, precision: 1, recall: 12 / 13, support: 13 },
    { type: "CLAIM_MISMATCH", tp: 0, fp: 0, fn: 22, precision: null, recall: 0, support: 22 },
  ],
  balancedCorrect: 20,
  balancedTotal: 30,
  n: 30,
  unscored: 1,
};

describe("results-snapshot rendering (the machine-written blocks of eval/RESULTS.md)", () => {
  it("renders the per-class table with — for undefined ratios and the unscored count", () => {
    const t = renderClassTable(report);
    expect(t).toContain("31 labeled rows (30 scorable, 1 unscored).");
    expect(t).toContain("| `OVERSPEND` | 1.00 | 0.92 | 12/0/1 | 13 |");
    expect(t).toContain("| `CLAIM_MISMATCH` | — | 0.00 | 0/0/22 | 22 |");
    expect(t).toContain("balanced/out-of-balance classified correctly: 20/30.");
  });

  it("omits the unscored clause when every row is scorable", () => {
    const t = renderClassTable({ ...report, n: 17, unscored: 0, balancedCorrect: 2, balancedTotal: 17 });
    expect(t).toContain("17 labeled rows (17 scorable).");
    expect(t).not.toContain("unscored");
  });

  it("renders the fuzz line with a locale-stable thousands separator", () => {
    const res: FuzzResult = { cases: 50_000, seed: 1234, failures: [], determinismFailures: 0 };
    expect(renderFuzzLine(res)).toBe(
      "- `npm run fuzz` → 50,000 mutated cases, seed 1234: **0 determinism failures, 0 invariant violations**.",
    );
  });

  it("renders the τ²-bench line from the committed results fields", () => {
    const line = renderTau2Line({ tasksAdapted: 164, inScopeCases: 164, falsePositives: 0 });
    expect(line).toContain("164 τ²-bench tasks: **0/164 false positives**");
    expect(line).toContain("bench/tau2/results.json");
  });

  it("renders the test-count line with the offline qualifier", () => {
    expect(renderTestsLine({ files: 59, passed: 349, skipped: 2 })).toContain(
      "59 files, **349 passed / 2 skipped** (fully offline",
    );
  });
});

describe("replaceBlock (marker surgery on RESULTS.md)", () => {
  const doc = "before\n<!-- repro:begin x -->\nstale\n<!-- repro:end x -->\nafter";

  it("replaces only the body between the named markers", () => {
    expect(replaceBlock(doc, "x", "fresh")).toBe("before\n<!-- repro:begin x -->\nfresh\n<!-- repro:end x -->\nafter");
  });

  it("is idempotent: re-applying the same body changes nothing", () => {
    const once = replaceBlock(doc, "x", "fresh");
    expect(replaceBlock(once, "x", "fresh")).toBe(once);
  });

  it("throws on missing markers instead of silently keeping stale numbers", () => {
    expect(() => replaceBlock(doc, "y", "fresh")).toThrow(/missing repro markers for "y"/);
  });

  it("throws when the end marker precedes the begin marker", () => {
    const swapped = "<!-- repro:end x -->\nbody\n<!-- repro:begin x -->";
    expect(() => replaceBlock(swapped, "x", "fresh")).toThrow(/end marker precedes/);
  });

  it("throws on duplicated markers (an ambiguous document must not be patched)", () => {
    expect(() => replaceBlock(doc + "\n" + doc, "x", "fresh")).toThrow(/duplicate repro markers/);
  });
});

describe("eval/RESULTS.md carries every marker the snapshot CLI patches", () => {
  it("has exactly one begin/end pair per generated block", () => {
    const md = readFileSync(join(process.cwd(), "eval", "RESULTS.md"), "utf8");
    for (const name of ["synthetic", "incidents", "fuzz", "tau2", "tests"]) {
      // replaceBlock throws on missing/duplicate/misordered markers — patching with a probe body
      // proves the document is patchable without asserting anything about the frozen numbers.
      expect(() => replaceBlock(md, name, "probe")).not.toThrow();
    }
  });
});
