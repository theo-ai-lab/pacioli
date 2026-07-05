import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuildInfo } from "./build-info";

const SHA = "a".repeat(40);
let dir: string;

const write = (content: string): void => {
  mkdirSync(join(dir, "lib", "generated"), { recursive: true });
  writeFileSync(join(dir, "lib", "generated", "build-info.json"), content);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pacioli-build-info-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readBuildInfo — deploy-time build provenance", () => {
  it("round-trips a valid file", () => {
    write(JSON.stringify({ sha: SHA, builtAt: "2026-07-05T00:00:00.000Z" }));
    expect(readBuildInfo(dir)).toEqual({ sha: SHA, builtAt: "2026-07-05T00:00:00.000Z" });
  });

  it("carries the dirty flag through, and only when literally true", () => {
    write(JSON.stringify({ sha: SHA, builtAt: "2026-07-05T00:00:00.000Z", dirty: true }));
    expect(readBuildInfo(dir)?.dirty).toBe(true);
    write(JSON.stringify({ sha: SHA, builtAt: "2026-07-05T00:00:00.000Z", dirty: "yes" }));
    expect(readBuildInfo(dir)?.dirty).toBeUndefined();
  });

  it("returns null when the file is absent (local dev — the honest fallback path)", () => {
    expect(readBuildInfo(dir)).toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", () => {
    write("{ not json");
    expect(readBuildInfo(dir)).toBeNull();
  });

  // A parity check that compared against a truncated/garbage "sha" could false-pass or produce a
  // confusing mismatch; strict validation collapses every malformed shape to "no build info".
  it("rejects anything that is not a full 40-hex sha", () => {
    for (const sha of [SHA.slice(0, 7), SHA.toUpperCase(), "g".repeat(40), 42, null, undefined]) {
      write(JSON.stringify({ sha, builtAt: "2026-07-05T00:00:00.000Z" }));
      expect(readBuildInfo(dir)).toBeNull();
    }
  });

  it("rejects a missing or unparseable builtAt", () => {
    write(JSON.stringify({ sha: SHA }));
    expect(readBuildInfo(dir)).toBeNull();
    write(JSON.stringify({ sha: SHA, builtAt: "not a date" }));
    expect(readBuildInfo(dir)).toBeNull();
  });

  it("rejects non-object roots", () => {
    for (const root of ["[]", '"sha"', "null", "7"]) {
      write(root);
      expect(readBuildInfo(dir)).toBeNull();
    }
  });
});
