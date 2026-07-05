/**
 * Pacioli — GET /api/version. Which commit is this deployment actually serving?
 *
 * Exists so claim-vs-deploy drift is checkable by anyone: the deploy-parity workflow
 * (.github/workflows/deploy-parity.yml) curls this on every push to main and weekly, and fails
 * the moment the live demo stops serving the commit the README claims it does.
 *
 * Deliberately UNAUTHENTICATED, unlike the rest of the API surface: the sha of a public repo is
 * not operational intel, and the whole point is that an anonymous CI job (or a skeptical reader)
 * can verify parity without a key. Sha source, in order of trust:
 *   1. lib/generated/build-info.json — written by scripts/predeploy.mjs (`npm run deploy`)
 *   2. VERCEL_GIT_COMMIT_SHA — populated by Vercel on git-connected deploys
 *   3. "unknown (local dev)" — the honest fallback; never a guess
 *
 * Zero new dependencies (Next App Router built-in). `no-store` so the parity check always sees
 * the live deploy, never a cached body.
 */
import { readBuildInfo } from "@/lib/api/build-info";
import pkg from "@/package.json";

export async function GET(): Promise<Response> {
  const info = readBuildInfo();
  const envSha = process.env.VERCEL_GIT_COMMIT_SHA;

  const body = info
    ? { sha: info.sha, builtAt: info.builtAt, version: pkg.version, source: "predeploy" as const, ...(info.dirty && { dirty: true }) }
    : envSha
      ? { sha: envSha, builtAt: null, version: pkg.version, source: "vercel-git" as const }
      : { sha: "unknown (local dev)", builtAt: null, version: pkg.version, source: "none" as const };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
