/**
 * Pacioli — deploy parity, asserted on DATA.
 *
 * A 200 on the landing page proves nothing: a deployment can serve every route, answer every health
 * check, and still reconcile wrongly. So this probe does the thing the product is FOR — it posts a
 * known fixture at `POST /api/reconcile` and holds the response to the verdict that fixture must
 * produce: flagged, `OVERSPEND`, `deltaUsd` +78.40, and the finding citing BOTH sides (the claim line
 * it contradicts and the evidence line that proves it). Anything less is a failed parity check.
 *
 * Zero dependencies, plain node — so the deploy-parity workflow can run it straight after a checkout
 * with no install step.
 *
 *   BASE=https://pacioliapp.vercel.app node scripts/parity-probe.mjs   # the live deploy
 *   BASE=http://127.0.0.1:3000        node scripts/parity-probe.mjs   # a local instance (CI)
 *
 * PACIOLI_API_KEY is sent as `x-api-key` when set, for a deployment that gates the API.
 * Exit 0 = the deployment reconciles correctly. Exit 1 = it does not, with the mismatch named.
 */

/** The fixture. Deliberately unambiguous: a $378.40 charge against a $300 authorized budget, claimed
 *  as within budget. Every deterministic rule in the engine agrees on this one, so a disagreement is
 *  a broken deployment, never a borderline call. */
export const FIXTURE = {
  agent: "deploy-parity-probe",
  task: "book one nonstop flight under $300",
  claim: "Booked the nonstop for $282.40, comfortably within your $300 budget.",
  authorized: { budgetUsd: 300, mayPurchase: true },
  evidence: {
    merchant: "United",
    amountUsd: 378.4,
    date: "2026-06-14",
    items: ["UA482 SFO-JFK nonstop", "Economy Plus seat"],
    excerpt: "Total charged: $378.40",
  },
};

/** What that fixture MUST come back as. */
export const EXPECTED = { balanced: false, findingType: "OVERSPEND", deltaUsd: 78.4, merchant: "United" };

/**
 * Hold a /api/reconcile response body to the expected verdict. Pure — no network — so the assertion
 * itself is unit-tested rather than only exercised against a live server.
 * @returns {string[]} the mismatches; empty means parity.
 */
export function checkVerdict(body) {
  const problems = [];
  if (!body || typeof body !== "object") return ["response body is not an object"];

  if (body.balanced !== EXPECTED.balanced) {
    problems.push(`balanced: expected ${EXPECTED.balanced}, got ${JSON.stringify(body.balanced)}`);
  }
  if (body.merchant !== EXPECTED.merchant) {
    problems.push(`merchant: expected ${EXPECTED.merchant}, got ${JSON.stringify(body.merchant)}`);
  }
  if (typeof body.deltaUsd !== "number" || Math.abs(body.deltaUsd - EXPECTED.deltaUsd) > 0.005) {
    problems.push(`deltaUsd: expected ${EXPECTED.deltaUsd}, got ${JSON.stringify(body.deltaUsd)}`);
  }
  if (typeof body.receiptId !== "string" || !/^sha256:[0-9a-f]{16}$/.test(body.receiptId)) {
    problems.push(`receiptId: expected sha256:<16 hex>, got ${JSON.stringify(body.receiptId)}`);
  }

  const findings = Array.isArray(body.findings) ? body.findings : [];
  const overspend = findings.find((f) => f && f.type === EXPECTED.findingType);
  if (!overspend) {
    problems.push(`findings: expected an ${EXPECTED.findingType}, got [${findings.map((f) => f && f.type).join(", ")}]`);
    return problems;
  }
  // The product's core promise is that a finding cites both sides. A deployment that flags without
  // citations is not serving this engine.
  if (!overspend.claimedRef || typeof overspend.claimedRef !== "string") {
    problems.push("the OVERSPEND finding cites no claim line (claimedRef)");
  }
  if (!overspend.actualRef || typeof overspend.actualRef !== "string") {
    problems.push("the OVERSPEND finding cites no evidence line (actualRef)");
  }
  if (overspend.llmAssisted !== false) {
    problems.push("the OVERSPEND finding is not the DETERMINISTIC one (llmAssisted should be false)");
  }
  return problems;
}

async function main() {
  const base = (process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
  const url = `${base}/api/reconcile`;
  const headers = { "content-type": "application/json", "cache-control": "no-cache" };
  if (process.env.PACIOLI_API_KEY) headers["x-api-key"] = process.env.PACIOLI_API_KEY;

  console.log(`PACIOLI — deploy parity, asserted on data: POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(FIXTURE),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) {
    console.error(`::error::POST /api/reconcile answered ${res.status} — the deployment cannot reconcile at all.`);
    console.error((await res.text()).slice(0, 500));
    return 1;
  }

  const body = await res.json();
  const problems = checkVerdict(body);
  if (problems.length > 0) {
    console.error("::error::Deploy parity FAILED — the live deployment returns the wrong verdict for a known fixture.");
    for (const p of problems) console.error(`  · ${p}`);
    console.error(JSON.stringify(body, null, 2).slice(0, 2000));
    return 1;
  }

  const f = body.findings.find((x) => x.type === EXPECTED.findingType);
  console.log(`  verdict   flagged, ${f.type}, deltaUsd +${body.deltaUsd}`);
  console.log(`  cites     claim: ${JSON.stringify(f.claimedRef)}`);
  console.log(`            evidence: ${JSON.stringify(f.actualRef)}`);
  console.log(`  receipt   ${body.receiptId} (stored: ${body.stored})`);
  console.log("PARITY — this deployment reconciles the fixture correctly, citations and all.");
  return 0;
}

// Only run the network probe when executed directly; importing this module (the unit test) must not
// hit the network.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::Deploy parity probe could not reach the deployment: ${err.message}`);
      process.exit(1);
    },
  );
}
