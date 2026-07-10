#!/usr/bin/env bash
# Pacioli — installability is a re-proven gate, not a one-time claim.
#
# Packs @pacioli-app/engine exactly as `npm publish` would, installs the tarball
# into a fresh consumer directory outside the workspace, and proves a stranger's
# three first moves work: require() the library and reconcile, run the CLI's
# --help, and gate on the CLI's exit-code contract (1 = out of balance).
#
# Run from anywhere: npm run smoke:install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "── pack ──────────────────────────────────────────────────────────────"
(cd "$ROOT" && npm pack -w packages/engine --pack-destination "$TMP")
TARBALL=("$TMP"/pacioli-app-engine-*.tgz)
[ -f "${TARBALL[0]}" ] || { echo "no tarball produced"; exit 1; }

echo "── install into a fresh consumer ─────────────────────────────────────"
mkdir "$TMP/consumer"
cd "$TMP/consumer"
npm init -y >/dev/null
npm install --no-audit --no-fund "${TARBALL[0]}" >/dev/null

echo "── require() + reconcile ─────────────────────────────────────────────"
node -e '
  const assert = require("node:assert");
  const { diff, buildReceipt } = require("@pacioli-app/engine");
  const input = {
    claim: {
      agent: "smoke-agent",
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
  const verdict = diff(input);
  assert.equal(verdict.balanced, false);
  assert.ok(verdict.findings.some((f) => f.type === "OVERSPEND"), "OVERSPEND must fire");
  assert.ok(verdict.findings.every((f) => f.claimedRef && f.actualRef), "citation invariant");
  buildReceipt(input).then((r) => {
    assert.match(r.receiptId, /^sha256:[0-9a-f]{16}$/);
    console.log("require + reconcile: OK", r.receiptId);
  });
'

echo "── CLI --help ────────────────────────────────────────────────────────"
npx pacioli --help | grep -q "reconcile"
echo "cli --help: OK"

echo "── CLI end-to-end (exit code IS the verdict) ─────────────────────────"
node -e '
  require("node:fs").writeFileSync("input.json", JSON.stringify({
    claim: { agent: "smoke-agent", task: "Book the nonstop, budget $220",
             text: "Booked.", authorized: { budgetUsd: 220, mayPurchase: true } },
    evidence: { source: "email", merchant: "AcmeAir", amountUsd: 298, date: "2026-06-01",
                items: ["Nonstop fare", "Trip insurance"], recurring: false,
                excerpt: "Total charged: $298.00 (incl. Trip insurance $78)" },
  }));
'
set +e
npx pacioli reconcile input.json --json > receipt.json
RC=$?
set -e
[ "$RC" -eq 1 ] || { echo "expected exit 1 (out of balance), got $RC"; exit 1; }
node -e '
  const assert = require("node:assert");
  const r = JSON.parse(require("node:fs").readFileSync("receipt.json", "utf8"));
  assert.equal(r.verdict.balanced, false);
  assert.match(r.receiptId, /^sha256:[0-9a-f]{16}$/);
  console.log("cli reconcile: OK, exit 1 +", r.verdict.findings.length, "cited finding(s)");
'

echo "install smoke: OK"
