import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, validateDiffInput } from "./cli";
import type { DiffInput } from "./types";

// ── harness ──────────────────────────────────────────────────────────────────

interface Capture {
  out: string;
  err: string;
}

async function run(argv: string[], stdin?: string): Promise<Capture & { code: number }> {
  const cap: Capture = { out: "", err: "" };
  const code = await runCli(argv, {
    out: (s) => (cap.out += s),
    err: (s) => (cap.err += s),
    readStdin: async () => stdin ?? "",
  });
  return { ...cap, code };
}

const tmp = mkdtempSync(join(tmpdir(), "pacioli-cli-"));

function fixtureFile(name: string, content: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

const outOfBalance: DiffInput = {
  claim: {
    agent: "example-agent",
    task: "Book the nonstop, budget $220",
    text: "Booked the nonstop for $220. No extras.",
    authorized: { budgetUsd: 220, mayPurchase: true },
  },
  evidence: {
    source: "email",
    merchant: "AcmeAir",
    amountUsd: 298,
    date: "2026-06-01",
    items: ["Nonstop fare", "Trip insurance"],
    recurring: false,
    excerpt: "Total charged: $298.00 (incl. Trip insurance $78)",
  },
};

const balanced: DiffInput = {
  claim: {
    agent: "example-agent",
    task: "Book the nonstop, budget $220",
    text: "Booked the nonstop for $214.",
    authorized: { budgetUsd: 220, mayPurchase: true },
  },
  evidence: {
    source: "email",
    merchant: "AcmeAir",
    amountUsd: 214,
    date: "2026-06-01",
    items: ["Nonstop fare"],
    recurring: false,
    excerpt: "Total charged: $214.00",
  },
};

// ── usage / flags ────────────────────────────────────────────────────────────

describe("pacioli CLI — usage", () => {
  it("--help prints usage to stdout and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pacioli");
    expect(r.out).toContain("reconcile");
    expect(r.out).toContain("--json");
    expect(r.err).toBe("");
  });

  it("-h is --help", async () => {
    const r = await run(["-h"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("reconcile");
  });

  it("no arguments prints usage to stderr and exits 2", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("reconcile");
  });

  it("an unknown command exits 2 with an error naming it", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("frobnicate");
  });

  it("an unknown flag exits 2 with an error naming it", async () => {
    const r = await run(["reconcile", fixtureFile("bal.json", balanced), "--frotz"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--frotz");
  });
});

// ── reconcile ────────────────────────────────────────────────────────────────

describe("pacioli CLI — reconcile", () => {
  it("balanced input: prints BALANCED, exits 0", async () => {
    const r = await run(["reconcile", fixtureFile("balanced.json", balanced)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("BALANCED");
    expect(r.out).toContain("sha256:");
  });

  it("out-of-balance input: prints the cited findings, exits 1", async () => {
    const r = await run(["reconcile", fixtureFile("oob.json", outOfBalance)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("OUT OF BALANCE");
    expect(r.out).toContain("OVERSPEND");
    expect(r.out).toContain("SCOPE_CREEP");
    // the citation invariant surfaces in the output: both sides quoted
    expect(r.out).toContain("authorized budget $220");
    expect(r.out).toContain("charged $298");
  });

  it("--json emits the full receipt as parseable JSON", async () => {
    const r = await run(["reconcile", fixtureFile("oob2.json", outOfBalance), "--json"]);
    expect(r.code).toBe(1);
    const receipt = JSON.parse(r.out);
    expect(receipt.receiptId).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.verdict.balanced).toBe(false);
    expect(receipt.verdict.findings).toHaveLength(2);
    expect(receipt.verdict.deltaUsd).toBe(78);
  });

  it("reads from stdin when the file argument is '-'", async () => {
    const r = await run(["reconcile", "-", "--json"], JSON.stringify(balanced));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).verdict.balanced).toBe(true);
  });

  it("a missing file exits 2 and names the path", async () => {
    const r = await run(["reconcile", join(tmp, "nope.json")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope.json");
  });

  it("malformed JSON exits 2", async () => {
    const r = await run(["reconcile", fixtureFile("bad.json", "{not json")]);
    expect(r.code).toBe(2);
    expect(r.err.toLowerCase()).toContain("json");
  });

  it("a structurally invalid input exits 2 and says what is missing", async () => {
    const r = await run(["reconcile", fixtureFile("invalid.json", { claim: { agent: "a" } })]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("evidence");
  });
});

// ── input validation ─────────────────────────────────────────────────────────

describe("validateDiffInput", () => {
  it("accepts a well-formed input", () => {
    expect(validateDiffInput(outOfBalance)).toEqual([]);
  });

  it("reports every missing piece, not just the first", () => {
    const problems = validateDiffInput({});
    expect(problems.join("\n")).toContain("claim");
    expect(problems.join("\n")).toContain("evidence");
  });

  it("rejects non-object roots", () => {
    expect(validateDiffInput("nope").length).toBeGreaterThan(0);
    expect(validateDiffInput(null).length).toBeGreaterThan(0);
  });

  it("type-checks the key fields", () => {
    const problems = validateDiffInput({
      claim: { agent: 1, task: "t", text: "x", authorized: {} },
      evidence: { source: "email", merchant: "m", amountUsd: "lots", items: "none", recurring: "yes", excerpt: "e" },
    });
    expect(problems.join("\n")).toContain("claim.agent");
    expect(problems.join("\n")).toContain("evidence.amountUsd");
    expect(problems.join("\n")).toContain("evidence.items");
    expect(problems.join("\n")).toContain("evidence.recurring");
  });
});
