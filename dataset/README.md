# Pacioli — Ground-Truth Dataset

The labeled set of (agent claim → human verdict → merchant evidence) that anchors
the whole build. This single asset does **four jobs**:

1. **Eval target** — the dataset every `inspect eval` run scores against.
2. **TDD fixture** — the diff engine is built red-green against these rows; the test
   suite *is* the accuracy harness.
3. **Demo data** — the same rows render as receipt cards in the live app.
4. **Methods section** — documented provenance + a reproducible split + measured
   per-class recall make every reported number traceable to a labeled row.

## Files

- [`schema.ts`](./schema.ts) — the typed contract (`AgentClaim`, `MerchantEvidence`,
  `Finding`, `Verdict`, `GroundTruthSample`). The source of truth for the wire shape.
- [`TAXONOMY.md`](./TAXONOMY.md) — what each verdict label means and how to decide it.
- [`ground-truth.seed.jsonl`](./ground-truth.seed.jsonl) — **synthetic fixtures**
  (provenance `synthetic-seed`) covering every finding class + dimension. Engine-dev /
  TDD data; never counted toward a reported rate.
- [`incidents.jsonl`](./incidents.jsonl) — **real AI-agent / automated-system failures**
  (provenance `public-incident`): a system did something other than it claimed or was
  instructed (Air Canada, Replit, the $1 Tahoe, Mata v. Avianca, …). Pacioli's on-thesis
  evidence. Tracked + citable. Every row was adversarially fact-checked against a primary
  or reputable source before inclusion.
- [`precedent.jsonl`](./precedent.jsonl) — **company dark-pattern enforcement** (Amazon,
  Instacart, Epic, Wells Fargo, Adobe, …), provenance `regulatory-precedent`. The *pre-agent*
  regulatory landscape — context, NOT autonomous-agent failures. The distinct provenance (not
  a filename) is what excludes it: no firewall predicate folds it into the incident class.
- `captured.jsonl` — **real self-run captures, raw** (gitignored; free text can carry PII).
  The only source eligible for the headline agent-misbehavior rate.
- `captured.public.jsonl` — the **committed redacted projection** of those runs, emitted by
  `npm run capture:publish` (contract fields + a short no-PII excerpt only). How the deployed
  site — and any stranger re-scoring the rate — sees the headline-eligible rows. Absent until
  real runs exist; the rate stays honestly `pending` until then.

## Coverage (seed)

31 samples · 3 balanced (MATCH) · 1 unscorable · 27 with findings.
All four classes covered: `OVERSPEND`, `SCOPE_CREEP`, `UNAUTH_RECURRENCE`,
`CLAIM_MISMATCH` (across dimensions money/time/item/quantity/scope/recurrence).

## How this grows

The seed is synthetic so the build is unblocked with zero sensitive access. The
**real** ground-truth set is built by labeling actual purchase/booking confirmations
from a real inbox (provenance `gmail`) — pairing each real confirmation (the *actual*
side) with the agent claim (real where agent-driven purchases exist, constructed
otherwise). Keep a **frozen held-out split** so reported accuracy is honest, never
fit-on-test.

> Privacy: rows carry only **extracted** fields plus a short redacted `excerpt` for
> the citation line — never a raw email body. See `TAXONOMY.md` and `schema.ts`.
