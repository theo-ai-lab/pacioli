# Ship-gate ledger — pacioli, 2026-08-02

Branch: `hardening/persisted-chain-and-verifier`. Two verdicts, reported
separately and never merged.

## What this gate caught

`GET /api/ledger` authenticated only when `PACIOLI_API_KEY` happened to be set.
Without it, a request carrying no `?session=` returned `store.list()` — every
user's receipts, each carrying the `sessionKey` it was filed under — while the
product surface promised "scoped to this browser. Nothing is shown that you
didn't enter."

Not exposed in production: the deployed build predates the route and returns
404. Redeploying without the fix is what would have shipped it. Now fails closed
(403) when no key is configured, and `sessionKey` never leaves the server in
either scope. Verified by disabling the guard and watching the refusal test fail.

## Scores

| # | Principle | Score | Evidence |
|---|---|---|---|
| P12 | Testing | **4** | 470 passed / 1 skipped across 68 files, cold clone. 272-case tamper drill, 100% caught, with a negative control that must verify. 50k-case metamorphic fuzz. |
| P13 | CI/CD | **3** | typecheck · lint · tests · ledger audit · tamper drill + report-drift gate · fuzz · eval · eval-snapshot drift · build · install smoke · a live instance held to a fixture's verdict. **Evidence is the PR run.** The equivalence, distillation and τ² rows are *not* in CI and the README now says so. |
| P14 | Observability | **3** | Hash-chained receipts with content addresses; `verifyLedger` reports located faults by kind. |
| P15 | Security fundamentals | **3** | The ledger boundary fix above. Tamper drill models 34 attack classes and pins 5 boundaries it cannot catch rather than claiming them. ADR-001 adds the off-box anchor and fails closed on a malformed one. |
| P19 | Infrastructure | **3** | Next 15 app, sqlite store with additive migrations, Vercel deploy. Deploy is stale relative to HEAD — parity is red by design until redeploy. |
| P24 | Measurable success criteria | **4** | `eval/RESULTS.md` regenerates byte-for-byte in CI or the build fails. Includes the unflattering number: 2 of 17 on documented public incidents. |
| P32 | Graders | **4** | Deterministic engine + gated judge, with the cascade's own equivalence check. Per-class precision/recall published with supports, including supports of 3 and 5 that do not support three-decimal confidence. |
| P36 | Onboarding / accurate mental models | **3** | External adversarial review by an independent frontier model from a different vendor. Top fold claimed "proves whether your agent told you the truth" while the floor abstains on exactly that class; now qualified, with the 2/17 surfaced in the fold rather than left in `eval/`. |

## Verdict 1 — Build Quality

**Strong.** The tamper drill is the best artifact here: 272 generated attacks
across 34 classes, all caught and located, with five boundaries *pinned as
boundaries* rather than quietly claimed — and a negative control first, because
a verifier that rejects everything proves nothing.

The honest weakness is evaluation design, not code. The labeled corpus is
simultaneously the tuning set, the test fixture, the demo dataset and the
methods exhibit; default tolerances were tuned against it; per-class numbers
rest on supports as low as 3. Those numbers are real measurements of a set the
author wrote, and should be read that way.

## Verdict 2 — External Adoption / Production Validation

**Unproven. No external users.** The live demo is deployed and reachable, but
there is no evidence of third-party use, and the τ² adapter constructs synthetic
receipts rather than replaying real trajectories — so "externally grounded" means
"grounded in an external task list", not validated by external users or data.
