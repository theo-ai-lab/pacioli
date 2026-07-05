/**
 * Pacioli — provenance of the running build, for GET /api/version.
 *
 * The sha comes from `lib/generated/build-info.json`, written by `scripts/predeploy.mjs` at
 * deploy-prep time (a Vercel CLI deploy builds remotely where `.git` is absent, so the sha must be
 * captured BEFORE upload — it cannot be read from git at build or request time). The file is
 * gitignored: committing it would let it drift from the commit it names, which is the exact class
 * of lie /api/version exists to make impossible.
 *
 * Validation is strict — a malformed file reads as "no build info", never as a plausible-looking
 * sha the deploy-parity check could false-pass on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Full 40-hex commit sha the build was prepared from. */
  sha: string;
  /** ISO-8601 timestamp of when the predeploy script captured the sha. */
  builtAt: string;
  /** Present (true) only when the tree was deliberately deployed dirty (`--allow-dirty`). */
  dirty?: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** Read + validate the generated build info. Returns null when the file is absent or malformed —
 *  the caller reports the honest fallback instead of guessing. */
export function readBuildInfo(dir: string = process.cwd()): BuildInfo | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "lib", "generated", "build-info.json"), "utf8");
  } catch {
    return null; // no file — local dev, or a deploy that skipped `npm run deploy`
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.sha !== "string" || !SHA_RE.test(o.sha)) return null;
  if (typeof o.builtAt !== "string" || Number.isNaN(Date.parse(o.builtAt))) return null;
  const info: BuildInfo = { sha: o.sha, builtAt: o.builtAt };
  if (o.dirty === true) info.dirty = true;
  return info;
}
