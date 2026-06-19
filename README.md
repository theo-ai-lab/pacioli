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

## The one idea

"What the agent claimed" versus "what actually happened" is **prediction versus ground truth**. So the
reconciliation engine isn't something an eval is bolted onto — it *is* an eval, and it's measured like one:
per-class precision/recall over a labeled set, deterministic rules first, every LLM judgment marked.

## The measured result

The deterministic engine, scored against the labeled fixtures. Precision is high where the engine commits,
because the rules are exact. Recall is the honest story.

| class | precision | recall | read |
|---|---:|---:|---|
| `OVERSPEND` | 1.00 | 0.92 | exact — a budget delta is a number |
| `UNAUTH_RECURRENCE` | 1.00 | 1.00 | exact — an authorization flag |
| `SCOPE_CREEP` | 1.00 | 0.80 | catches "spent when told not to", unrequested add-ons, violated "do not send" |
| `CLAIM_MISMATCH` | — | 0.00 | **abstained by design** → routed to the LLM judge |

Two things this table is *not* hiding:

1. **`CLAIM_MISMATCH` recall is 0.** That's deliberate. Fuzzy claims ("cheapest", a wrong date) aren't
   something a deterministic rule should pretend to judge, so the engine abstains and hands them to a gated
   LLM judge that marks every finding `llm-assisted`. Run the 17 documented incidents through the engine and
   it abstains on almost all of them — because real-world agent failures are overwhelmingly claim-mismatches.
   That's the argument for deterministic-first: be exact where you can be, don't guess where you can't.
2. **There is no "agents misbehave X%" headline yet.** That number can only come from real runs commissioned
   against a live card (`self-run`/`gmail` provenance). A provenance *firewall* in the code forbids filling it
   with synthetic or third-party data. It is pending, on purpose.

Nothing above is a number in prose. Reproduce it:

```bash
npm test          # the full suite — unit + property-based & metamorphic fuzzing of the engine contract
npm run eval      # the per-class table above, in the terminal
npm run fuzz      # 50,000 mutated cases against the formal invariants in SPEC.md

# the citable harness — Inspect AI (UK AISI). The TS engine is the classifier; this only scores it.
npm run eval:build
inspect eval eval/discrepancy_eval.py --model mockllm/model -T split=all -T seed=1234
```

## How it works

- **Deterministic-first, LLM-marked.** Plain typed TypeScript rules (`lib/engine/diff.ts`) run in the browser:
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

## Verifiable by construction

The engine is treated as safety-relevant code, not a demo script:

- **A formal contract.** Behaviour is specified as 10 firing invariants **and 6 metamorphic relations** in
  [`SPEC.md`](SPEC.md), written as executable predicates (`lib/engine/spec.ts`, `lib/engine/metamorphic.ts`) —
  the numeric invariants re-derived independently of the engine, the scope sub-rules a single shared module
  by design (so contract and engine cannot drift), with an independent rules-as-data mirror
  (`lib/engine/rules-dsl.ts`) cross-checked against the engine over thousands of fuzzed inputs.
- **Property-based + metamorphic fuzzing.** A seeded fuzzer mutates inputs against the rule boundaries —
  **100,000 cases, zero violations** (`npm run fuzz -- 100000`; the default run and CI use 50,000) —
  checking both the firing contract and relational truths (more money
  charged can't fix an overspend; raising the budget can't create one; granting authorization can't add
  findings). Runs in the test suite and on every build (`npm run fuzz`).
- **Diagnosis, not just detection.** Each finding carries ranked, deterministic root-cause hypotheses
  ("+$78 → likely an undisclosed seat fee + add-on") — closer to a black-box recorder than a tripwire.
- **Tamper-evident, auditable receipts.** Each receipt is content-addressed (SHA-256 over its claim, evidence,
  and verdict) and batched into a **Merkle audit trail**: one root commits to a session, and an inclusion proof
  shows a receipt belongs to it *without revealing the others* — selective transparency, no SNARK
  (`lib/engine/merkle.ts`). Signed, hash-chained agent receipts are themselves prior art
  ([Pipelock](https://github.com/luckyPipewrench/pipelock), [Acta](https://github.com/VeritasActa/Acta),
  in-toto/Sigstore) — Pacioli's contribution is the *reconciliation* a receipt commits to, not the receipt
  format. See [`docs/RELATED_WORK.md`](docs/RELATED_WORK.md).
- **The judge is a measured instrument.** A calibration harness (`lib/engine/judge-eval.ts`) scores it against
  human labels (TPR/FPR, precision/recall, Cohen's κ), reports rates as Wilson **confidence intervals** not
  points, and runs a positional-bias probe — ready the moment a key and labels exist.
- **Externally grounded.** Run against the 164 real airline + retail tasks of [τ²-bench](https://github.com/sierra-research/tau2-bench)
  (Sierra, MIT), the engine produces **zero false positives** on the in-scope reference trajectories
  (`npm run bench:tau2`). Honestly scoped — a specificity check, not a τ²-bench score; see [`bench/tau2/`](bench/tau2).
- **CI re-proves it.** A GitHub Actions workflow runs typecheck + lint + tests + fuzz + eval + build (and the
  Inspect harness) on every push — the eval is a regression gate, not a one-time claim.

## Use it from a live agent (MCP)

Pacioli ships a [Model Context Protocol](https://modelcontextprotocol.io) server, so an agent (Claude Desktop,
the Claude CLI) can call it **mid-task** to self-issue a receipt — double-entry bookkeeping in the loop, not just
post-hoc. Three read-only tools over the same deterministic engine: `reconcile_claim` (one-shot), plus
`reconcile_pr` and `reconcile_stream` for evidence that arrives **incrementally** (a PR's diff stats → CI, or a
confirmation that lands field by field) — they report the earliest prefix at which a verdict is monotone-safe to
commit (flag an oversized agent PR as `OVERSPEND` before CI even finishes). See [`mcp/`](mcp).

```bash
npm run mcp                                # stdio (tools: reconcile_claim, reconcile_pr, reconcile_stream)
npx tsx mcp/smoke.ts                       # end-to-end self-check
npm run reconcile:pr -- --gate < pr.json   # the PR adapter as a CLI gate — exit 1 on a flagged agent PR
```

## Wire it into your pipeline

The same engine is exposed everywhere an agent stack might need a receipt:

**HTTP API.** `POST /api/reconcile` takes the claim + evidence and returns the verdict, the typed findings,
and the tamper-evident receipt id. Deterministic by default; pass `"judge": "auto" | "local" | "anthropic"`
to also run the LLM judge — **judge selection is only honored for authenticated callers** (set
`PACIOLI_API_KEY`, send `x-api-key`; constant-time compared), is rate-limited with a daily cost ceiling, and
the response's `judgeMode` tells you the truth: `off`, `unauthorized`, `unavailable` (requested backend can't
run — never disguised as "ran clean"), `error`, or the backend that ran. Note the split: `balanced` and
`findings` are always the **deterministic** verdict (that is what the receipt hash commits to); judge results
arrive separately as `judgeFindings` — if you enable a judge, gate on both. Bodies are byte-capped at the
transport (413 past 64KB, even chunked). Errors: `400` bad JSON · `401` bad key · `413` too large ·
`422` invalid shape · `429` judge rate-limited.

**Prometheus metrics.** `GET /api/metrics` (honors the same key) exposes `pacioli_reconciliations_total`
(true event counter — replays of the same content-addressed receipt each count), `pacioli_receipts_unique`,
`pacioli_receipts_flagged`, `pacioli_findings_by_type{type=…}`, and `pacioli_store_info{backend=…}` so you
can see whether you're on durable `sqlite` (set `PACIOLI_DB=/path/receipts.db`) or the in-memory fallback.

**CI gate (SARIF / JUnit).** `npm run audit -- --gate corpus.jsonl` reconciles a JSONL corpus of
claim/evidence pairs and exits non-zero if any claim is flagged — drop it into CI to fail a build on agent
misbehavior. `--format sarif` (default) uploads as a GitHub code-scanning report; `--format junit` feeds any
JUnit consumer; `--out file` writes the report to disk. Malformed rows warn loudly **and fail the gate** —
a skipped row is an unaudited claim, never a silent pass.

**Framework adapter.** `lib/integrations/langchain.ts` is a dependency-free `reconcileRun()` shaped for a
LangChain/Agent-SDK callback — receipt an agent run mid-loop without importing any framework.

**Parallel deterministic surfaces.** Beyond the 4-class engine: line-item reconciliation (itemized prices
must sum to the stated total — `lib/engine/line-items.ts`), a tool-use auditor against an allowlist/approval
policy (OWASP-Agentic ASI02/03 — `lib/engine/tooluse.ts`), and a pre-deploy agent-config scanner
(`lib/engine/config-scan.ts`) that fails CI on un-capped budgets or ungated dangerous tools.

**Optional hardening.** `npm install @noble/post-quantum` activates ML-DSA-65 signing over the Merkle root
(`lib/engine/pqc.ts`). The external-benchmark adapter (`npm run bench:ale`, live data via `ALE_DATASET`)
ingests any agent dataset with honest coverage reporting, and `npm run bench:perf` benchmarks the engine
with a latency regression gate.

| env var | does |
|---|---|
| `ANTHROPIC_API_KEY` | enables the hosted judge |
| `OLLAMA_URL` / `LOCAL_JUDGE_MODEL` | the on-device judge (defaults: `localhost:11434`, `qwen2.5:3b`) |
| `PACIOLI_API_KEY` | requires `x-api-key` on the API + metrics; unlocks judge selection over HTTP |
| `PACIOLI_DB` | durable receipt store via Node's built-in sqlite |
| `ALE_DATASET` | live dataset id for the external-benchmark adapter (`npm run bench:ale`) |

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

## The Ledger Report

A wall of real, source-cited agent failures rendered as receipts — Air Canada's chatbot, Replit wiping a
production database, the $1 Tahoe, *Mata v. Avianca*. Every card links to a primary or reputable source.
Cases still in active litigation are walled off and labeled **alleged**, and one defamation-adjacent
consumer-complaint pattern is held back entirely. Every incident was adversarially fact-checked before
inclusion.

![The Ledger Report: documented agent failures as receipts](docs/ledger.png)

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

Design system: [`DESIGN.md`](DESIGN.md). Engine contract: [`SPEC.md`](SPEC.md). Threat model:
[`SECURITY.md`](SECURITY.md). Dataset and provenance rules: [`dataset/`](dataset). Eval harness: [`eval/`](eval).
Related work & eval landscape: [`docs/RELATED_WORK.md`](docs/RELATED_WORK.md). Reproduced results: [`eval/RESULTS.md`](eval/RESULTS.md).

## License

[MIT](LICENSE).
