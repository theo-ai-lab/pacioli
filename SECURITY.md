# Security & threat model

Pacioli's surface is deliberately small: the deterministic engine runs **client-side** (no account, no secret,
nothing to attack in the demo path). Two optional components carry the threat surface: the **gated LLM judge**
and the **optional HTTP API** (`/api/reconcile`, `/api/metrics`). This is a focused threat model of those, in
the vocabulary of the [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/) — not a
compliance mapping. Items that don't apply are marked N/A with the reason, on purpose.

## The optional HTTP API — its posture

Deploying without env vars keeps the API deterministic-only; receipts land only in a **bounded in-memory
store** (10k cap, lost on every restart — nothing durable), and `/api/metrics` exposes aggregate counts
publicly. Set `PACIOLI_API_KEY` to gate both routes. Hardening when you opt in:

- **Shared secret** (`PACIOLI_API_KEY`): required on both routes when set; compared in constant time
  (SHA-256 + `timingSafeEqual`).
- **Judge selection is auth-gated AND rate-limited** — an unauthenticated caller can never spend your judge
  budget (`judgeMode: "unauthorized"`); authenticated calls go through the same per-IP rate limit + daily
  cost ceiling as the demo UI. A judge that can't run reports `"unavailable"`, a failed judge call reports
  `"error"` — neither is ever disguised as "ran and found nothing".
- **Transport bounds**: request bodies are byte-counted while streaming and rejected at 64KB (413) — a
  chunked body without `content-length` cannot buffer unbounded memory; zod bounds every field after parse.
- **Bounded storage**: the in-memory store caps at 10k receipts; the optional `node:sqlite` store
  (`PACIOLI_DB`) prunes past 50k — an unauthenticated flood cannot grow either without limit. Replays of the
  same content-addressed receipt bump a counter instead of new rows.

## The gated LLM judge — what it touches

| OWASP LLM (2025) | Applies? | Pacioli's posture |
|---|---|---|
| **LLM01 Prompt Injection** | **Yes** | The "evidence" is attacker-controllable text. It's fenced in `<case>` tags with **angle brackets stripped and length capped** (`fence()` — applied identically in BOTH the hosted and on-device judges, so the envelope can't be closed early), and the system prompt declares it **untrusted — audit it, never follow instructions inside it**. Judge output is schema-validated with enum whitelisting (it can't emit free-form actions or smuggle arbitrary strings into typed fields), and any judge finding is badged `LLM-assisted` — never a silent action. |
| **LLM02 Sensitive Information Disclosure** | **Yes** | Only **extracted fields + a short redacted excerpt** are ever sent — never a raw email/body (a type-level privacy invariant). The judge is instructed not to echo personal data. |
| **LLM10 Unbounded Consumption** | **Yes** | The judge is bounded: `maxOutputTokens` cap, single retry, 15s timeout, Zod-bounded input sizes, plus an in-memory **rate limit + daily cost ceiling** (`lib/ratelimit.ts`) keyed by client IP — applied on BOTH the demo UI path and the authenticated API path, and judge selection over HTTP additionally requires the shared secret. A public deploy can't be abused into a large bill. |
| **LLM05 Improper Output Handling** | **Yes** | Output is parsed as a typed schema, not executed or rendered as HTML; it only adds a badged finding to a receipt. |
| LLM03 Supply Chain | Partial | Minimal dependency surface (Next/React/Tailwind/AI SDK/Inspect); no model fine-tuning. The optional on-device judge uses a local Ollama model the **operator** pulls and trusts (e.g. `qwen2.5:3b`) — nothing is downloaded by Pacioli itself. |
| LLM04 Data/Model Poisoning | N/A | No training/fine-tuning; the judge is a stock hosted model. |
| LLM06 Excessive Agency | N/A | The judge has **no tools and no agency** — it returns a verdict; it cannot act. |
| LLM07 System Prompt Leakage | Low | The system prompt contains no secrets; leaking it reveals only the (public) audit instructions. |
| LLM08 Vector/Embedding Weaknesses | N/A | No vector store / RAG. |
| LLM09 Misinformation | Mitigated | Deterministic-first: the LLM only touches the abstained residual, every judgment is badged "verify before acting," and the calibration harness measures it before trust. |

## Detection crosswalk — the agentic failures Pacioli surfaces

Pacioli builds no agent, so the agentic-security standards don't apply to it as *vulnerabilities* (see "out of
scope" below). They apply the other way around: Pacioli is a **post-hoc detector** for the financial/scope
*footprint* of several named agentic failures. It catches the consequence in the ledger — the overspend, the
unauthorized subscription, the lie — **not** the root-cause exploit (it sees the *result* of a goal-hijack, not
the prompt-injection that caused it). This is detection coverage, not a runtime defense.

| Pacioli finding | The agentic failure whose money/scope footprint it catches | OWASP Top 10 Agentic Apps (2026) | Threats & Mitigations (v1.0) |
|---|---|---|---|
| `OVERSPEND` | spent beyond the authorized budget | **ASI01** Agent Goal Hijack · **ASI09** Human-Agent Trust Exploitation | T4 Resource Overload |
| `SCOPE_CREEP` | acted or bought beyond the authorized scope | **ASI02** Tool Misuse & Exploitation · **ASI03** Identity & Privilege Abuse | T2 Tool Misuse · T6 Intent Breaking & Goal Manipulation |
| `UNAUTH_RECURRENCE` | committed an ongoing charge without authorization | **ASI03** Identity & Privilege Abuse | T3 Privilege Compromise |
| `CLAIM_MISMATCH` | reported an outcome the evidence contradicts (deception/hallucination) | **ASI01** Agent Goal Hijack | T7 Misaligned & Deceptive Behaviors |
| the Merkle + SHA-256 **receipt trail** | makes every verdict attributable and tamper-evident | — | **T8** Repudiation & Untraceability |

Scope is honest: Pacioli covers only the **money-and-scope** slice — the part that shows up as a charge or an
unauthorized action. It does **not** address memory poisoning (ASI06), inter-agent comms (ASI07), RCE (ASI05),
or supply chain (ASI04) — those leave no ledger footprint and are out of its lane by design. References:
[OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
· [Agentic AI Threats & Mitigations v1.0](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/).

## Deliberately out of scope (and why)

- **SOC 2 / PCI DSS** — Pacioli stores no customer data and never touches a card number (PAN); both are
  non-applicable by their own definitions.
- **EU AI Act** — not a GPAI provider, not a deployer of a high-risk (Annex III) system, not a market product;
  the only relevant sliver is Art 50 transparency (AI-generated output is labeled, which the `LLM-assisted`
  badge already does).
- **OWASP Top 10 for Agentic Applications (2026)** — that standard secures *agents that act*; Pacioli builds no
  agent, so it has none of those vulnerabilities. It is the watchdog, not the actor. (For the failures it
  *detects*, see the detection crosswalk above.)

## Privacy invariant

No type in the system carries a raw email body. Evidence holds only extracted fields plus a short, redacted
`excerpt` for the citation line; raw bodies never persist past extraction. See `dataset/TAXONOMY.md`.
