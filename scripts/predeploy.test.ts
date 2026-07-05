import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuildInfo } from "@/lib/api/build-info";

// The script under test, run as a real subprocess against a real (temp) git repo — the failure
// modes that matter here (dirty tree, no repo) only exist at the process boundary.
const SCRIPT = join(import.meta.dirname, "predeploy.mjs");

let repo: string;

const sh = (cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string =>
  execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }) as string;

/** Run predeploy in the temp repo; returns { code, output } instead of throwing. */
const predeploy = (...args: string[]): { code: number; output: string } => {
  try {
    return { code: 0, output: sh(process.execPath, [SCRIPT, ...args]) };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { code: err.status ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pacioli-predeploy-"));
  sh("git", ["init", "-q"]);
  // Mirror the real repo: the generated file is gitignored, so writing it never dirties the tree.
  writeFileSync(join(repo, ".gitignore"), "/lib/generated/\n");
  sh("git", ["add", ".gitignore"]);
  sh("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("scripts/predeploy.mjs — capture the sha before the source leaves the machine", () => {
  it("writes build info that matches git HEAD exactly and round-trips through readBuildInfo", () => {
    const before = Date.now();
    const { code, output } = predeploy();
    expect(code).toBe(0);
    const head = sh("git", ["rev-parse", "HEAD"]).trim();
    expect(output).toContain(head);

    const raw = JSON.parse(readFileSync(join(repo, "lib", "generated", "build-info.json"), "utf8"));
    expect(raw.sha).toBe(head);
    expect(raw.dirty).toBeUndefined();
    expect(Date.parse(raw.builtAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(raw.builtAt)).toBeLessThanOrEqual(Date.now() + 1000);

    // The exact reader /api/version uses accepts the exact file the script writes.
    expect(readBuildInfo(repo)).toEqual({ sha: head, builtAt: raw.builtAt });
  });

  it("refuses a dirty tree — a clean-looking sha over uncommitted code would falsify the parity check", () => {
    writeFileSync(join(repo, "uncommitted.txt"), "x");
    const { code, output } = predeploy();
    expect(code).not.toBe(0);
    expect(output).toMatch(/dirty/);
    expect(existsSync(join(repo, "lib", "generated", "build-info.json"))).toBe(false);
  });

  it("--allow-dirty records { dirty: true } instead of refusing", () => {
    writeFileSync(join(repo, "uncommitted.txt"), "x");
    const { code } = predeploy("--allow-dirty");
    expect(code).toBe(0);
    expect(readBuildInfo(repo)?.dirty).toBe(true);
  });

  it("fails outside a git repository rather than inventing a sha", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const { code, output } = predeploy();
    expect(code).not.toBe(0);
    expect(output).toMatch(/not a git repository/);
    expect(existsSync(join(repo, "lib", "generated", "build-info.json"))).toBe(false);
  });

  it("overwrites stale build info from a previous deploy", () => {
    predeploy();
    sh("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "next"]);
    const head = sh("git", ["rev-parse", "HEAD"]).trim();
    expect(predeploy().code).toBe(0);
    expect(readBuildInfo(repo)?.sha).toBe(head);
  });
});
