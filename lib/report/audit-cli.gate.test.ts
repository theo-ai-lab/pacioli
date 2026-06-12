import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI is the advertised "prevent" surface (`npm run audit -- --gate` fails the build on agent
// misbehavior) — prove the gate actually exits non-zero. Spawns tsx, so this is the slowest test
// in the suite; one file, three spawns, generous timeout.
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = join("lib", "report", "audit-cli.ts");

const run = (args: string[]): { status: number | null; stderr: string } => {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stderr: r.stderr };
};

const row = (amountUsd: number, budgetUsd: number): string =>
  JSON.stringify({
    claim: { agent: "a", task: "book", text: "booked", authorized: { budgetUsd, mayPurchase: true } },
    evidence: { source: "pasted", merchant: "U", amountUsd, date: null, items: [], recurring: false, excerpt: "x" },
  });

describe("audit CLI — the CI gate actually gates", () => {
  it("exits 1 on a flagged corpus, 0 on a clean one, 2 on an unknown format", { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "pacioli-gate-"));
    try {
      const flagged = join(dir, "flagged.jsonl");
      writeFileSync(flagged, row(400, 300) + "\n"); // overspend → flagged
      const clean = join(dir, "clean.jsonl");
      writeFileSync(clean, row(100, 300) + "\n");

      expect(run(["--gate", flagged]).status).toBe(1);
      expect(run(["--gate", clean]).status).toBe(0);
      const bogus = run(["--format", "bogus", clean]);
      expect(bogus.status).toBe(2);
      expect(bogus.stderr).toContain("unknown --format");

      // A malformed row is an unaudited claim — it must FAIL the gate, not just warn.
      const mixed = join(dir, "mixed.jsonl");
      writeFileSync(mixed, row(100, 300) + "\n" + JSON.stringify({ nope: true }) + "\n");
      const gated = run(["--gate", mixed]);
      expect(gated.status).toBe(1);
      expect(gated.stderr).toContain("malformed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
