# Pacioli

[![CI](https://github.com/theo-ai-lab/pacioli/actions/workflows/ci.yml/badge.svg)](https://github.com/theo-ai-lab/pacioli/actions/workflows/ci.yml)

### Did your AI actually do what it said?

Double-entry bookkeeping for AI agents. Pacioli reconciles what an agent **claimed** it did — booked, bought,
subscribed — against what the **evidence** shows, and prints a receipt when the two don't reconcile.

![The Pacioli demo: an agent claim and a confirmation reconciled into a receipt](docs/hero.png)

> Spend trackers show you what was charged. Pacioli proves whether your agent told you the truth.

**[Live demo → pacioliapp.vercel.app](https://pacioliapp.vercel.app)** — paste a claim + a confirmation, get the receipt.
**[/methods](https://pacioliapp.vercel.app/methods)** is the per-class eval · **[/ledger](https://pacioliapp.vercel.app/ledger)** is the live **record → reconcile → review** loop (forward a confirmation, watch it file into your own receipt ledger) plus real, source-cited failures as receipts · or run it locally in 30 seconds ([below](#run-it-locally)).

---

## Add it to your agent stack in 5 minutes

Pacioli is built for one user: **the agent developer who wants every agent PR and every agent
purchase receipted in CI.** Your agent reports back in prose; Pacioli turns that report into a
claim, reconciles it against the evidence, and hands your pipeline an exit code.

The deterministic core ships as [`@pacioli-app/engine`](packages/engine) — zero runtime
dependencies, Node ≥ 20 or any modern browser, CLI included. **npm publish pending:** v0.1.0 is
prepared (the [release workflow](.github/workflows/release.yml) publishes on the first tag) but is
not on the registry yet — so there is no `npm install @pacioli-app/engine` line here until that
line actually works. Today the install is from a clone:

**1 · Install the engine + CLI** *(~2 minutes — npm publish pending)*

```bash
git clone https://github.com/theo-ai-lab/pacioli && cd pacioli && npm install
npm pack -w packages/engine                # → pacioli-app-engine-0.1.0.tgz
cd ../your-agent-repo && npm install ../pacioli/pacioli-app-engine-0.1.0.tgz
```

**2 · Receipt one agent claim** *(~2 minutes)* — JSON in, receipt out:

```bash
npx --no-install pacioli reconcile - <<'JSON'
{
  "claim": { "agent": "trip-bot", "task": "Book the nonstop, budget $220",
             "text": "Booked the nonstop for $220. No extras.",
             "authorized": { "budgetUsd": 220, "mayPurchase": true } },
  "evidence": { "source": "email", "merchant": "AcmeAir", "amountUsd": 298,
                "date": "2026-06-01", "items": ["Nonstop fare", "Trip insurance"],
                "recurring": false,
                "excerpt": "Total charged: $298.00 (incl. Trip insurance $78)" }
}
JSON
# → OUT OF BALANCE: OVERSPEND over budget by $78.00 + SCOPE_CREEP "Trip insurance",
#   each citing the claim line and the evidence line. Exit code 1.
```

**3 · Gate the pipeline** *(~1 minute)* — the exit code is the verdict
(`0` balanced · `1` out of balance · `2` error), so one CI step gates a build:

```yaml
- name: Receipt the agent's claim
  run: npx --no-install pacioli reconcile agent-claim.json
```

`--no-install` matters: the bare name `pacioli` on the npm registry belongs to an unrelated
project, so never let `npx` fetch it — the CLI comes from `@pacioli-app/engine`, installed above.
Richer gates — a SARIF PR gate, a JSONL corpus audit, MCP receipts mid-task — are
[one table down](#one-engine-every-surface).

## How it works

- **Deterministic-first, LLM-marked.** Plain typed TypeScript rules (`packages/engine/src/diff.ts`) run in the browser:
  overspend, unauthorized recurrence, and scope creep are exact and instant, no account or key. Only the fuzzy
  residual falls through to the judge, and every judge finding is badged so an LLM verdict never silently
  drives a decision.
- **Every finding cites both sides.** A `Finding` cannot exist without a `claimedRef` and an `actualRef` — the
  exact claim line and the exact evidence line that prove it. An uncited discrepancy isn't representable.
- **The provenance firewall.** Synthetic fixtures, documented public incidents, and real commissioned captures
  are three separate classes. Synthetic can never reach a reported rate; the real headline number is gated to
  real runs only. The metric code filters on provenance before it reports.
- **Privacy as a type, not a policy.** The contract carries only extracted fields plus a short redacted excerpt
  — never a raw email body. The gated judge sends only those, fenced as untrusted input, and is bounded
  (token cap, single retry, 15s timeout).

## One engine, every surface

The same deterministic engine, exposed wherever an agent stack needs a receipt. One row per
surface here; each surface's full contract — auth, error codes, judge semantics — is in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md#surface-contracts).

| surface | what gets receipted | entry point |
|---|---|---|
| **CLI** | one claim; the exit code is the verdict | `pacioli reconcile claim.json` |
| **HTTP API** | claim + evidence over the wire → typed findings + tamper-evident receipt id; optional gated LLM judge | `POST /api/reconcile` |
| **MCP server** ([`mcp/`](mcp)) | an agent receipting itself **mid-task** (Claude Desktop, the Claude CLI); `reconcile_pr` / `reconcile_stream` handle evidence that arrives incrementally | `npm run mcp` |
| **PR gate** | an agent's pull request — flagged (`OVERSPEND` on an oversized diff) before CI even finishes | `npm run reconcile:pr -- --gate < pr.json` |
| **CI corpus audit** | a JSONL corpus of claims → SARIF (GitHub code scanning) or JUnit; malformed rows fail the gate, never skip | `npm run audit -- --gate corpus.jsonl` |
| **Prometheus metrics** | the receipt store itself: totals, flagged counts, findings by type, store backend | `GET /api/metrics` |
| **Deploy parity** | the deployment: the exact sha it serves, re-checked against `main` in CI on every push and weekly | `GET /api/version` |
| **Framework adapter** | a LangChain/Agent-SDK run, receipted mid-loop with zero framework imports | [`lib/integrations/langchain.ts`](lib/integrations/langchain.ts) |

Also deterministic, also engine-side: line-item sum checks ([`lib/engine/line-items.ts`](lib/engine/line-items.ts)),
a tool-use auditor against an allowlist/approval policy ([`lib/engine/tooluse.ts`](lib/engine/tooluse.ts)),
a pre-deploy agent-config scanner ([`lib/engine/config-scan.ts`](lib/engine/config-scan.ts)), and
optional ML-DSA-65 signing over the Merkle root ([`lib/engine/pqc.ts`](lib/engine/pqc.ts)).

| env var | does |
|---|---|
| `ANTHROPIC_API_KEY` | enables the hosted judge |
| `OLLAMA_URL` / `LOCAL_JUDGE_MODEL` | the on-device judge (defaults: `localhost:11434`, `qwen2.5:3b`) |
| `PACIOLI_API_KEY` | requires `x-api-key` on the API + metrics; unlocks judge selection over HTTP |
| `PACIOLI_DB` | durable receipt store via Node's built-in sqlite (unset — as on the deployed demo — = in-memory by design) |
| `ALE_DATASET` | live dataset id for the external-benchmark adapter (`npm run bench:ale`) |

The deployed demo sets no `PACIOLI_DB`, so `backend="memory"` on its live
[`/api/metrics`](https://pacioliapp.vercel.app/api/metrics) is the honest reading — receipts are
per-instance and reset on each deploy, by design.

## The Ledger Report

A wall of real, source-cited agent failures rendered as receipts — Air Canada's chatbot, Replit wiping a
production database, the $1 Tahoe, *Mata v. Avianca*. Every card links to a primary or reputable source.
Cases still in active litigation are walled off and labeled **alleged**, and one defamation-adjacent
consumer-complaint pattern is held back entirely. Every incident was adversarially fact-checked before
inclusion.

![The Ledger Report: documented agent failures as receipts](docs/ledger.png)

## Why this approach

- **Rules before a model.** The classes that are actually deterministic (a number over budget, a recurring
  flag) get exact rules with near-perfect precision. Reaching for an LLM here would add cost, latency, and
  non-determinism to solve a problem `if` statements already solve.
- **An LLM only on the residual, and only when measured.** There are two judges behind one router: a hosted
  Claude judge (your own key) and an **on-device judge via [Ollama](https://ollama.com)** — no key, nothing
  leaves your machine (`ollama pull qwen2.5:3b`). Both are measurement instruments to be calibrated against
  human labels (TPR/TNR, Cohen's κ) before trust. Until then they're assistive and clearly badged.
- **No heavyweight backend.** The riskiest assumption isn't the plumbing, it's whether a zero-setup receipt
  lands — so the demo runs entirely client-side with nothing to set up. The optional HTTP API persists
  receipts through Node's **built-in** `node:sqlite` (set `PACIOLI_DB`) — durable storage with zero added
  dependencies, no ORM, no Redis. Gmail OAuth and a full stored ledger come only if the demo lands.

## How it's verified

Pacioli doesn't ask you to trust the engine — it measures it. "What the agent claimed" versus
"what actually happened" is **prediction versus ground truth**, so the engine isn't something an
eval is bolted onto: it *is* an eval, and it's measured like one — per-class scores over a labeled
set, deterministic rules first, every LLM judgment marked. This section is the summary;
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) is the full account.

### The measured result

The deterministic engine, scored against the labeled fixtures. Precision is high where the engine
commits, because the rules are exact. Recall is the honest story.

| class | precision | recall | read |
|---|---:|---:|---|
| `OVERSPEND` | 1.00 | 0.92 | exact — a budget delta is a number |
| `UNAUTH_RECURRENCE` | 1.00 | 1.00 | exact — an authorization flag |
| `SCOPE_CREEP` | 1.00 | 0.80 | catches "spent when told not to", unrequested add-ons, violated "do not send" |
| `CLAIM_MISMATCH` | — | 0.00 | **abstained by design** → routed to the LLM judge |

Two things this table is *not* hiding:

1. **`CLAIM_MISMATCH` recall is 0 — deliberate.** Fuzzy claims ("cheapest", a wrong date) aren't
   something a deterministic rule should pretend to judge; the engine abstains and routes them to
   the gated judge, which marks every finding `llm-assisted`. Real-world agent failures are
   overwhelmingly claim-mismatches — that's the argument *for* deterministic-first.
2. **There is no "agents misbehave X%" headline yet — on purpose.** That number can only come from
   real commissioned runs; a provenance firewall in the code forbids synthetic stand-ins. When the
   runs happen, `npm run capture:publish` commits their redacted projection so a stranger can
   re-score the rate, not take it on faith.

Nothing above is a number in prose. Reproduce it:

```bash
npm test          # the full suite — unit + property-based & metamorphic fuzzing of the engine contract
npm run eval      # the per-class table above, in the terminal
npm run fuzz      # 50,000 mutated cases against the formal invariants in SPEC.md

# the citable harness — Inspect AI (UK AISI). The TS engine is the classifier; this only scores it.
npm run eval:build
inspect eval eval/discrepancy_eval.py --model mockllm/model -T split=all -T seed=1234
```

### Verifiable by construction

The engine is treated as safety-relevant code, not a demo script. One row per claim; the full
account of each mechanism is in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md#verifiable-by-construction).

| claim | mechanism | reproduce | source |
|---|---|---|---|
| The contract is executable | 10 firing invariants + 6 metamorphic relations as predicates, cross-checked against an independent rules-as-data mirror | `npm test` | [`SPEC.md`](SPEC.md) · [`spec.ts`](packages/engine/src/spec.ts) |
| The rules survive fuzzing | seeded property-based + metamorphic fuzzer at the rule boundaries — **100,000 cases, zero violations** | `npm run fuzz -- 100000` | [`fuzz.ts`](lib/engine/fuzz.ts) |
| Findings diagnose, not just detect | ranked deterministic root-cause hypotheses on every finding (the receipt's `likely` line) | `npm test` | [`hypotheses.ts`](packages/engine/src/hypotheses.ts) |
| Receipts are tamper-evident | SHA-256 content addressing + Merkle inclusion proofs — selective transparency, no SNARK | `npm test` | [`merkle.ts`](packages/engine/src/merkle.ts) · [`RELATED_WORK.md`](docs/RELATED_WORK.md) |
| The fast path is falsifiable | deterministic tier ≡ judge-on-everything, measured over 48 labeled fixtures: ~40% resolved with zero escalation, 0 lossless violations, zero model spend | `npm run reconcile -- --equivalence` | [`cascade.ts`](lib/engine/cascade.ts) |
| Distilled rules must survive a holdout | jury consensus proposes rules; out-of-sample gold labels promote or reject them (1 promoted, 1 rejected; deterministic coverage 39.6% → 54.2%) | `npm run distill` | [`jury.ts`](lib/engine/jury.ts) · [`distill.ts`](lib/engine/distill.ts) |
| The judge's risk is bounded honestly | Clopper–Pearson upper bound on selective risk; the certificate's width is shown vs N — never a small-N headline | `npm run certify` | [`selective-risk.ts`](lib/engine/selective-risk.ts) |
| The judge is a measured instrument | TPR/FPR, precision/recall, Cohen's κ vs human labels as Wilson intervals — **pending a key + labels** | `npm run calibrate` | [`judge-eval.ts`](lib/engine/judge-eval.ts) |
| Externally grounded | **zero false positives** on the in-scope reference trajectories of τ²-bench's 164 real airline + retail tasks — a specificity check, not a benchmark score | `npm run bench:tau2` | [`bench/tau2/`](bench/tau2) |
| CI re-proves all of it | typecheck · lint · tests · fuzz · eval · snapshot drift gate · build · install smoke · Inspect harness, on every push | — | [`ci.yml`](.github/workflows/ci.yml) |

## Limitations & known failure modes

- `SCOPE_CREEP` recall is 0.80: the engine catches "purchased when no purchase was authorized", unrequested
  add-on products (insurance, warranties — including when the user said "no trip insurance"; a negated mention
  is a prohibition, not a request), and violated "do not send / draft only" instructions. It still abstains on
  subtler substitutions ("a different hotel than asked"), which need the judge's comparison.
- A handful of documented *advice*-failures (a "no purchase" scope with a downstream dollar amount) trip a
  `SCOPE_CREEP` false positive. It's disclosed in the Methods page, not hidden.
- Detector accuracy on fixtures is **not** a claim about real-world prevalence. That's the separate, pending
  headline number.
- The fixture set is small, so the per-class numbers carry real standard error (surfaced by Inspect's
  `stderr()`, not hidden).

## Run it locally

```bash
npm install            # Node >= 22.5 (the optional receipt store uses Node's built-in sqlite)
npm run dev            # http://localhost:3000
```

Optional: put `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`) to enable the live LLM judge. Without
it, the app is deterministic-only and the demo still works end to end.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind v4 · TypeScript · Vercel AI SDK 6 with a selectable
judge (gated Claude `claude-haiku-4-5`, or on-device via Ollama) · Inspect AI for the eval · Vitest. The demo
is paste-only with no database; the optional API persists via Node's built-in `node:sqlite` (zero added deps).

Design system: [`DESIGN.md`](DESIGN.md). Engine contract: [`SPEC.md`](SPEC.md). Verification depth:
[`docs/VERIFICATION.md`](docs/VERIFICATION.md). Threat model:
[`SECURITY.md`](SECURITY.md). Dataset and provenance rules: [`dataset/`](dataset). Eval harness: [`eval/`](eval).
Related work & eval landscape: [`docs/RELATED_WORK.md`](docs/RELATED_WORK.md). Reproduced results: [`eval/RESULTS.md`](eval/RESULTS.md).

## License

[MIT](LICENSE).
