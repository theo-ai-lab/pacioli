# External validation — τ²-bench (Sierra Research, MIT)

Pacioli's engine, run against real tasks from [τ²-bench](https://github.com/sierra-research/tau2-bench)
(Sierra Research, MIT-licensed), the recognized agent customer-service benchmark.

```bash
npm run bench:tau2   # fetches airline + retail tasks (164; cached to .cache/, not redistributed), writes results.json
```

## What this validates — and what it doesn't (read this)

τ²-bench's **public task JSONs** expose each task's **user intent** and a **ground-truth reference action
trajectory** (`cancel` / `exchange` / `modify` / `book` …), but **not dollar amounts** — those live in the
environment database and are realized only by replaying actions. Pacioli's deterministic engine is
money-centric, so this harness validates the dimension the public data cleanly supports: **authorization
scope.**

For each real task it builds two traceable cases (tagged by τ²-bench task id):

- **in-scope** — the agent performs exactly the authorized operation, no unauthorized purchase → expect
  `BALANCED`. (Specificity / false-positive test on real task intents + reference actions.)
- **violation** — the same *real* authorization, but the agent slips in an unauthorized purchase →
  expect `SCOPE_CREEP`. (Sensitivity. The purchase amount is **constructed**.)

### Result

- **0 / 164 false positives** on the real in-scope reference trajectories — Pacioli does not wrongly flag a
  single correct, authorized agent action across the benchmark.
- scope-creep recall **1.0** / precision **1.0** on the constructed violations.

### Honest caveats (this is a *specificity* check, not a τ²-bench score)

- **Scope only.** Overspend / recurrence are **not** validated here — the public JSONs carry no amounts, so
  the in-scope cases balance partly because there is nothing monetary to flag. The 0/164 is a genuine
  "no-false-alarms-on-real-trajectories" result, not a claim of full reconciliation accuracy.
- Violation amounts are **constructed**; the authorization and reference actions are **real** (traceable).
- The **deep** validation — the LLM **judge** vs τ²-bench's DB-state/policy correctness on real **agent
  trajectories** — needs an API key + the environment, and is scaffolded here as future work.

MIT data © 2025 Sierra Research. Fetched on demand, not redistributed.
