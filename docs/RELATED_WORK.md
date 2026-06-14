# Pacioli — Related Work, the Eval Landscape, and Limitations

Where Pacioli sits in two adjacent fields — agent **evaluation** (how you grade what an agent did)
and verifiable **agent receipts** (how you prove it) — what is genuinely prior art, and, held to the
project's own honesty bar, what Pacioli does **not** claim. Every external reference here was
web-verified (June 2026); where a popular framing would over-claim, the correct one is given.

## 1 · The eval landscape — deterministic-first is consensus, not novelty

Pacioli's "deterministic rules first, the LLM judge only on the residual, every model verdict marked"
stance is the **mainstream 2025–26 position**, not a Pacioli invention. Saying so plainly is the honest
framing; the actual contribution is in §3.

| System / source | What it establishes | Relation to Pacioli |
|---|---|---|
| **Anthropic — "Demystifying evals for AI agents"** ([anthropic.com](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), Jan 2026) | Canonical deterministic-first guidance — deterministic graders where possible, an LLM judge only where necessary, humans judiciously; evals as CI. | Pacioli *operationalises* this as an enforced, machine-checkable invariant, not a recommendation. |
| **promptfoo** ([docs](https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/)) | 40+ deterministic, no-LLM, no-account assertions (incl. `trajectory:tool-sequence`, `trajectory:tool-args-match`, latency/cost) that run offline on recorded traces. | Prior art for "deterministic checks in CI." promptfoo aggregates pass/fail; it does not provenance-tag each verdict or reconcile claim-vs-evidence. |
| **DeepEval** (Confident AI, [repo](https://github.com/confident-ai/deepeval)) | Pytest-style eval; `ToolCorrectnessMetric` is deterministic (reference-based tool/order/arg comparison). **Note:** its `ArgumentCorrectnessMetric` is *LLM-based*, not deterministic. | Closest OSS "deterministic + judge in one suite." Mixes verdicts into one aggregate score; no verdict-provenance ledger. |
| **Inspect AI** (UK AI Security Institute, [repo](https://github.com/UKGovernmentBEIS/inspect_ai)) | Government-grade Task/Solver/Scorer framework; deterministic scorers, seeding/`temp=0` for reproducibility; 200+ prebuilt evals. | Pacioli's citable harness *is* an Inspect task (`eval/discrepancy_eval.py`): Inspect scores, the Pacioli engine classifies. |
| **τ-bench / τ²-bench** (Sierra Research, [repo](https://github.com/sierra-research/tau2-bench)) | Agent success scored by deterministic comparison of final DB state to a goal — not judge opinion. | Exemplar of deterministic state-checking. Pacioli runs against τ²-bench as a specificity check (`bench/tau2/`), honestly scoped — *not* a τ²-bench score. |
| **ABC checklist** — *Establishing Best Practices for Building Rigorous Agentic Benchmarks* (Zhu et al., [arXiv:2507.02825](https://arxiv.org/abs/2507.02825), Jul 2025) | A rigor checklist; shows mis-designed benchmarks misestimate by up to 100% (e.g. "τ-bench counts empty responses as successful"). | The rigor bar Pacioli's provenance firewall + abstention-scored-as-miss aim at. ABC is a *manual human checklist*; Pacioli enforces provenance in code. |
| **Justice or Prejudice?** (Ye et al., [arXiv:2410.02736](https://arxiv.org/abs/2410.02736)) | Quantifies 12 LLM-as-judge biases (position, verbosity, self-preference, …) via the CALM framework. | The evidence base for Pacioli's "every judge verdict marked `llmAssisted`, never silently a deterministic pass." |

## 2 · Verifiable agent receipts — Pacioli's receipt is **not** the novelty

Pacioli's content-addressed, Merkle-batched receipt is a sound but **commoditized** primitive. Signed,
hash-chained, offline-verifiable agent receipts are an active and (on the pure crypto axis) more-mature
space:

| System | What it does | Relation to Pacioli |
|---|---|---|
| **Pipelock** ([github.com/luckyPipewrench/pipelock](https://github.com/luckyPipewrench/pipelock)) | OSS agent firewall emitting **mediator-signed Ed25519, hash-chained** action receipts (RFC 8785/JCS canonical; `chain_prev_hash` = SHA-256 of the prior envelope), verifiable offline, with verifiers in Go/TS/Rust/Python. | Signs receipts from *outside* the agent boundary (egress vantage) — more mature cryptographic-receipt tooling than Pacioli, with different semantics (it attests *traffic*; Pacioli attests a *reconciliation verdict*). |
| **Acta** ([github.com/VeritasActa/Acta](https://github.com/VeritasActa/Acta)) | Open protocol for signed, verifiable machine decisions: Ed25519 receipts, hash-chained audit trails, an in-toto predicate type, 2 IETF Internet-Drafts. | Direct prior art for "signed, verifiable decision receipts." |
| **in-toto / Sigstore / SLSA** ([in-toto](https://github.com/in-toto/in-toto)) | Foundational signed-attestation supply-chain stack (in-toto predicates, keyless signing, provenance levels). | The substrate the agent-receipt work builds on; Pacioli's receipt is a lightweight cousin, not a contribution to this line. |
| **SCITT** (IETF Supply Chain Integrity, Transparency and Trust) | Pre-RFC transparency-service architecture for COSE-signed statements + publicly verifiable receipts. | A forward path *if* Pacioli ever needs a public transparency log; not used today. |

**So:** do not pitch Pacioli on "tamper-evident receipts" — that axis is owned by Pipelock / Acta /
in-toto. The receipt is table-stakes packaging around the actual contribution.

## 3 · Pacioli's precise slot

**Claim-vs-evidence reconciliation as a first-class, measured, provenance-marked eval.** The novelty is
*not* the deterministic rules (consensus, §1), the judge gating (consensus), or the cryptographic
receipt (Pipelock / Acta / in-toto, §2). It is the **double-entry framing** — every claimed side-effect
booked against its evidence, scored with an abstention-honest per-class metric — and the
**verdict-provenance invariant**: a reviewer can strip every `llmAssisted` cell and recompute trust,
because no model verdict can masquerade as a deterministic pass. In the surveyed work, no eval tool
frames agent verification as a reconciled ledger, and no receipt tool carries claim-vs-evidence
reconciliation semantics. The *composition* is the contribution; each conjunct is prior art.

## 4 · Limitations (the disclosed corners)

- **The per-class numbers are on synthetic fixtures.** On the 17 documented public incidents the
  deterministic engine largely **abstains** (real failures are overwhelmingly `CLAIM_MISMATCH`) and
  over-fires `SCOPE_CREEP` on a couple of advice-failures — disclosed in the README and Methods page,
  not hidden. There is no real-world "agents misbehave X%" headline; it is gated to real
  `self-run`/`gmail` provenance and pending.
- **The cryptographic-receipt axis is not where Pacioli competes** (§2). Lead with reconciliation.
- **The judge is uncalibrated** until a key + human labels exist; the calibration harness
  (`lib/engine/judge-eval.ts`, Cohen's κ, Wilson intervals) is built and pending.
