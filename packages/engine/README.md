# @pacioli-app/engine

The zero-dependency deterministic core of [Pacioli](https://github.com/theo-ai-lab/pacioli) —
claim-vs-evidence reconciliation for AI agents.

> Publishing status: v0.1.0 is prepared but **not yet on the npm registry**.
> Until the first release lands, consume it from this repo as an npm workspace.

An agent says *"booked the flight, $220, no extras."* The confirmation email
says $298 with trip insurance. This package is the part of Pacioli that catches
that — deterministically, with a receipt:

- **`diff(input)`** — the typed rule engine. Every `Finding` must cite the exact
  claim line *and* the exact evidence line that prove it (the citation invariant
  is enforced at the type level). The fuzzy residual (`CLAIM_MISMATCH`) is an
  explicit abstention, never a guess.
- **`buildReceipt(input)`** — the canonical receipt pipeline: diff → SHA-256
  content hash → top abductive cause → `sha256:<fingerprint>` id.
- **`receiptHash` / `verifyReceipt` / `chainHash`** — tamper-evident content
  addressing over the canonical `{claim, evidence, verdict}`.
- **`merkleRoot` / `merkleProof` / `verifyProof`** — batch receipts into a
  Merkle audit trail; prove inclusion without revealing the other receipts.
- **`checkInvariants(input, verdict)`** — the engine contract
  ([SPEC.md](../../SPEC.md)) as executable predicates, independently restated so
  it cross-checks the engine rather than restating it.

Zero runtime dependencies. Web Crypto only, so the library runs in Node 20+ and
every modern browser. TypeScript types ship with the package.

## Use

```ts
import { buildReceipt, type DiffInput } from "@pacioli-app/engine";

const input: DiffInput = {
  claim: {
    agent: "example-agent",
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

const receipt = await buildReceipt(input);
// receipt.verdict.balanced === false
// receipt.verdict.findings: OVERSPEND (+$78) and SCOPE_CREEP (trip insurance), each with citations
// receipt.receiptId: "sha256:<first 16 hex of the content hash>"
```

## CLI

The package ships a `pacioli` executable over the same deterministic core. The
exit code is the verdict, so one command gates a pipeline:

```sh
pacioli reconcile input.json          # human-readable receipt
pacioli reconcile - --json < in.json  # full receipt as JSON, input from stdin
```

| Exit code | Meaning |
| --- | --- |
| `0` | balanced — the books reconcile |
| `1` | out of balance — at least one cited finding |
| `2` | usage, I/O, or validation error (nothing was reconciled) |

Deterministic rules only: `CLAIM_MISMATCH` is an explicit abstention here. The
LLM judge lives in the app, behind a key — never in this package.

## What stays in the app

The LLM judge, the jury/distillation research harness, the eval dataset, the
HTTP API, and the MCP server live in the [repo root](../../) — they have
dependencies and keys. This package is only the part that never needs either.

## License

[MIT](../../LICENSE)
