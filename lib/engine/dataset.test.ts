// The captured-runs loader must honor the publish path: the private raw corpus
// (dataset/captured.jsonl, never committed) wins when present; otherwise the
// committed redacted corpus (dataset/captured.public.jsonl, emitted by
// `npm run capture:publish`) supplies the same headline-eligible rows — that is
// what lets the deployed site render a rate a stranger can re-score.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCaptured, loadJsonl } from "./dataset";

const row = (id: string) =>
  JSON.stringify({
    id,
    input: {
      claim: { agent: "test", task: "t", text: "x", authorized: { mayPurchase: false, mayRecur: false } },
      evidence: {
        source: "email",
        merchant: "m",
        amountUsd: null,
        date: null,
        items: [],
        recurring: false,
        excerpt: "e",
      },
    },
    target: { balanced: true, findings: [] },
    meta: { provenance: "self-run" },
  });

const dirs: string[] = [];
function tempDatasetDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pacioli-dataset-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadCaptured", () => {
  it("falls back to the published redacted corpus when no private captures exist", () => {
    const dir = tempDatasetDir({ "captured.public.jsonl": row("pub-1") + "\n" + row("pub-2") + "\n" });
    expect(loadCaptured(dir).map((r) => r.id)).toEqual(["pub-1", "pub-2"]);
  });

  it("prefers the private raw corpus over the published one (they describe the same runs)", () => {
    const dir = tempDatasetDir({
      "captured.jsonl": row("priv-1") + "\n",
      "captured.public.jsonl": row("pub-1") + "\n",
    });
    expect(loadCaptured(dir).map((r) => r.id)).toEqual(["priv-1"]);
  });

  it("returns an honest empty when neither file exists", () => {
    const dir = tempDatasetDir({});
    expect(loadCaptured(dir)).toEqual([]);
  });
});

describe("loadJsonl", () => {
  it("skips malformed lines instead of dropping the whole file", () => {
    const dir = tempDatasetDir({ "captured.jsonl": "{not json\n" + row("ok-1") + "\n" });
    expect(loadJsonl("captured.jsonl", dir).map((r) => r.id)).toEqual(["ok-1"]);
  });
});
