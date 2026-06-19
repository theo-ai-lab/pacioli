/**
 * Pacioli — CORS for the cross-origin /api/reconcile seam.
 *
 * The reconcile endpoint is meant to be called from another origin (e.g. the Career Coach running in a
 * browser), so it answers the CORS preflight and echoes the allow-* headers on every response.
 *
 * Default is open ("*"): the route carries NO cookies/ambient credentials — authentication is the
 * explicit `x-api-key` header — so a wildcard origin cannot be abused via the browser's credentialed-
 * request machinery (a credentialed request with `Allow-Origin: *` is rejected by the browser anyway).
 * Set PACIOLI_CORS_ORIGIN to a comma-separated allowlist to lock it down: a matching `Origin` is echoed
 * back (with `Vary: Origin`), otherwise the first configured origin is returned.
 */

const ALLOW_METHODS = "POST, OPTIONS";
const ALLOW_HEADERS = "content-type, x-api-key, x-pacioli-session";
const MAX_AGE = "86400";

/** The CORS headers for a given request, honoring an optional PACIOLI_CORS_ORIGIN allowlist. */
export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": ALLOW_METHODS,
    "access-control-allow-headers": ALLOW_HEADERS,
    "access-control-max-age": MAX_AGE,
  };

  const configured = process.env.PACIOLI_CORS_ORIGIN?.trim();
  if (!configured || configured === "*") {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }

  const allowlist = configured.split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin");
  headers["access-control-allow-origin"] = origin && allowlist.includes(origin) ? origin : allowlist[0];
  headers["vary"] = "Origin"; // the response varies by Origin, so caches must key on it
  return headers;
}

/** Standard preflight response: 204, no body, CORS headers only. */
export function corsPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
