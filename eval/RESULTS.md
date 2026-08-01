# Pacioli — Reproduced Eval Results (snapshot)

A frozen snapshot of the engine's measured results, reproduced **offline** (no API key, no network).
Regenerate any line with the command shown. These are **classifier accuracy on labeled sets**, not a
real-world prevalence claim — see *Headline misbehavior rate* below.

Reproduced 2026-07-05 · Node 24 · deterministic (seeded). The content between `repro` markers is
machine-written by `npm run eval:snapshot`; CI regenerates it on every push and fails on any drift, so
these numbers cannot silently lag the engine.

## Synthetic fixtures — `npm run eval`

<!-- repro:begin synthetic -->
31 labeled rows (30 scorable, 1 unscored).

| class | precision | recall | tp/fp/fn | support |
|---|---:|---:|---|---:|
| `OVERSPEND` | 1.00 | 0.92 | 12/0/1 | 13 |
| `SCOPE_CREEP` | 1.00 | 0.80 | 4/0/1 | 5 |
| `UNAUTH_RECURRENCE` | 1.00 | 1.00 | 3/0/0 | 3 |
| `CLAIM_MISMATCH` | — | 0.00 | 0/0/22 | 22 |

balanced/out-of-balance classified correctly: 20/30.
<!-- repro:end synthetic -->

`CLAIM_MISMATCH` recall of 0.00 here is the design, not a miss: the deterministic floor abstains on the
LLM residual and routes it to the gated judge.

## Documented public incidents — `npm run eval` — the honest real-data picture

On messy, real incidents the deterministic floor mostly **abstains** (real-world agent failures are
overwhelmingly `CLAIM_MISMATCH`) and **over-fires `SCOPE_CREEP` twice**. This is the real-data number, and
it is deliberately not flattering:

<!-- repro:begin incidents -->
17 labeled rows (17 scorable).

| class | precision | recall | tp/fp/fn | support |
|---|---:|---:|---|---:|
| `OVERSPEND` | — | 0.00 | 0/0/1 | 1 |
| `SCOPE_CREEP` | 0.00 | 0.00 | 0/2/2 | 2 |
| `UNAUTH_RECURRENCE` | — | — | 0/0/0 | 0 |
| `CLAIM_MISMATCH` | — | 0.00 | 0/0/17 | 17 |

balanced/out-of-balance classified correctly: 2/17.
<!-- repro:end incidents -->

This is *why* the design routes the fuzzy residual to a gated, marked judge — and why the per-class
headline above is explicitly labeled **synthetic**, not a claim about real agents. The two `SCOPE_CREEP`
false positives are advice-failure cases (a "no purchase" scope with a downstream dollar amount);
disclosed here and on the Methods page, not hidden.

## Headline misbehavior rate — pending, gated (no synthetic fill-in)

`npm run eval` → `AGENT-MISBEHAVIOR RATE (real commissioned runs only): 0/0`. There is **no** real-world
prevalence number. The provenance firewall forbids filling it with synthetic or incident data; it needs
real `self-run`/`gmail` captures against a live card and is pending on purpose.

## Other reproduced checks

<!-- repro:begin fuzz -->
- `npm run fuzz` → 50,000 mutated cases, seed 1234: **0 determinism failures, 0 invariant violations**.
<!-- repro:end fuzz -->
- Inspect harness (offline `mockllm/model`): per-class precision/recall reproduce the synthetic table;
  set-match `accuracy 0.233` (abstentions dominate the strict aggregate, by design).
<!-- repro:begin tau2 -->
- `npm run bench:tau2` → 164 τ²-bench tasks: **0/164 false positives** on in-scope trajectories — a specificity check; money dimensions are not validated and violation amounts are constructed (see [`bench/tau2/results.json`](../bench/tau2/results.json)).
<!-- repro:end tau2 -->
<!-- repro:begin tests -->
- `npm test` → 65 files, **420 passed / 2 skipped** (fully offline: the optional live-Ollama and post-quantum-dep paths skip).
<!-- repro:end tests -->

Reproduce everything: `npm test && npm run eval && npm run fuzz && npm run bench:tau2`. Verify this
snapshot against the engine the way CI does: `npm run eval:snapshot && git diff --exit-code eval/RESULTS.md`.
