#!/usr/bin/env node
// Pacioli — capture the commit being deployed, BEFORE the source leaves the machine.
//   node scripts/predeploy.mjs                 # refuses on a dirty tree
//   node scripts/predeploy.mjs --allow-dirty   # records { dirty: true } instead of refusing
//
// Writes lib/generated/build-info.json ({ sha, builtAt }), which GET /api/version serves and the
// deploy-parity workflow asserts against origin/main. Runs automatically before `npm run deploy`
// (npm's `predeploy` hook). A Vercel CLI deploy builds remotely where `.git` is absent — this is
// the only moment the sha can be captured honestly. Zero dependencies.
//
// The file is gitignored on purpose: a committed sha would drift from the commit it names. It
// reaches the remote build because .vercelignore (which controls the CLI upload) does not exclude
// it — if you edit .vercelignore, keep lib/generated/ uploadable.
//
// Refusing on a dirty tree is the point, not pedantry: the parity check compares the deployed sha
// to a commit, so deploying uncommitted changes under a clean-looking sha would falsify the very
// claim this machinery exists to make checkable.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const allowDirty = process.argv.includes("--allow-dirty");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let sha, porcelain;
try {
  sha = git("rev-parse", "HEAD");
  porcelain = git("status", "--porcelain");
} catch {
  console.error("predeploy: not a git repository (or git is unavailable) — cannot capture a sha honestly.");
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`predeploy: "${sha}" is not a full commit sha.`);
  process.exit(1);
}

const dirty = porcelain.length > 0;
if (dirty && !allowDirty) {
  console.error("predeploy: working tree is dirty — the deployed code would not match the recorded sha.");
  console.error("           Commit first, or pass --allow-dirty to record { dirty: true } in the build info.");
  process.exit(1);
}

const info = { sha, builtAt: new Date().toISOString(), ...(dirty && { dirty: true }) };
const dir = join(process.cwd(), "lib", "generated");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

console.log(`predeploy: wrote lib/generated/build-info.json → ${sha}${dirty ? " (DIRTY TREE — parity will not hold)" : ""}`);
