import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BuildInfo } from "@/lib/api/build-info";
import pkg from "@/package.json";

// Build info under our control — the route reads it via readBuildInfo().
const h = vi.hoisted(() => ({ info: null as BuildInfo | null }));
vi.mock("@/lib/api/build-info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/build-info")>();
  return { ...actual, readBuildInfo: () => h.info };
});

import { GET } from "./route";

const SHA = "b".repeat(40);

const KEY_ORIG = process.env.PACIOLI_API_KEY;
const VERCEL_SHA_ORIG = process.env.VERCEL_GIT_COMMIT_SHA;
beforeEach(() => {
  h.info = null;
  delete process.env.PACIOLI_API_KEY;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});
afterEach(() => {
  if (KEY_ORIG !== undefined) process.env.PACIOLI_API_KEY = KEY_ORIG;
  if (VERCEL_SHA_ORIG !== undefined) process.env.VERCEL_GIT_COMMIT_SHA = VERCEL_SHA_ORIG;
});

describe("GET /api/version — deploy provenance", () => {
  it("serves the predeploy-captured sha and build time", async () => {
    h.info = { sha: SHA, builtAt: "2026-07-05T00:00:00.000Z" };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sha: SHA,
      builtAt: "2026-07-05T00:00:00.000Z",
      version: pkg.version,
      source: "predeploy",
    });
  });

  it("falls back to 'unknown (local dev)' — never a guess — when no build info exists", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ sha: "unknown (local dev)", builtAt: null, version: pkg.version, source: "none" });
  });

  it("uses Vercel's git sha on git-connected deploys (no predeploy file)", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    const body = await (await GET()).json();
    expect(body).toEqual({ sha: SHA, builtAt: null, version: pkg.version, source: "vercel-git" });
  });

  it("the predeploy file wins over the env sha (it names what was actually uploaded)", async () => {
    h.info = { sha: SHA, builtAt: "2026-07-05T00:00:00.000Z" };
    process.env.VERCEL_GIT_COMMIT_SHA = "c".repeat(40);
    expect((await (await GET()).json()).sha).toBe(SHA);
  });

  it("surfaces a dirty-tree deploy instead of hiding it", async () => {
    h.info = { sha: SHA, builtAt: "2026-07-05T00:00:00.000Z", dirty: true };
    expect((await (await GET()).json()).dirty).toBe(true);
  });

  it("is never cached — the parity check must see the live deploy", async () => {
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });

  // Deliberate exception to "PACIOLI_API_KEY covers the whole API surface": the sha of a public
  // repo is not operational intel, and the route exists precisely so an UNauthenticated CI job
  // can verify deploy parity. This test documents that as a decision, not an oversight.
  it("stays public even when PACIOLI_API_KEY is set", async () => {
    process.env.PACIOLI_API_KEY = "k";
    expect((await GET()).status).toBe(200);
  });
});
