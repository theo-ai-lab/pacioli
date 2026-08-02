# Security review — the off-box anchor changeset

**Range:** `99aa98a^..7ea5c8d` (5 commits) · **Date:** 2026-08-02
**Scope:** 11 files changed; small enough to read every dependency rather than sample.

The anchor decides whether a ledger verifies, so the changeset that introduced it was read as
security-relevant code: what it can pass, what it can fail, and what it silently lets through.
[`ADR-001`](ADR-001-off-box-anchor.md) records the design decision; this records the review of it.

## Triage

| File | Δ | Risk | Why |
|---|---|---|---|
| `lib/store/verify-ledger.ts` | +90 | **HIGH** | It *is* the security verdict. Changes the verdict shape and adds a comparison that can pass or fail a ledger. |
| `lib/store/verify-ledger-cli.ts` | +78 | **HIGH** | Exit codes are the CI gate. `0` is documented as "the ledger verifies". |
| `lib/store/ledger-anchor.ts` | +108 | **HIGH** | Parses a file from outside the trust boundary and drives the comparison. |
| `lib/store/anchor-ledger-cli.ts` | +63 | MEDIUM | Produces the commitment; cannot pass a bad ledger (refuses one that fails its walk). |
| `ledger-anchor.test.ts`, `ledger-chain.test.ts` | +299 | LOW | Tests. |
| `README.md`, `docs/*` | +122 | LOW | Documentation. |
| `package.json` | +3 | LOW | One script entry, no dependency added. |

**No new dependencies.** Confirmed: the diff adds one npm *script*, zero packages.

## Was any security check removed?

Every `-` line in `verify-ledger.ts` is a signature or return-shape change, re-added with the
`anchored` field. No validation, no fault kind, and no comparison was deleted.

`git blame` on the surrounding chain-walk logic shows it untouched by this range — the walk that
existed before the anchor still runs identically, and the anchor comparison is strictly additive.

## Test coverage

Adequate, but **only after a defect**. The original tests could not fail for the root or head
comparison: every mismatch case differed in *count*, so the count comparison caught all of them.
Deleting both the root and head lines left the suite green at 54/54 — measured by removing them,
not assumed. `boundary-full-reseal-rewrite` (the count-preserving variant) now pins them; deleting
either line fails 2 tests.

**Elevated risk while that held:** a changeset whose tests cannot detect the removal of its own
central comparison is effectively untested for that comparison, however green the suite looks. It
is fixed here, and the standard is worth keeping — a test that cannot fail is not evidence.

## Blast radius

8 files reference `verifyLedger` / `LedgerReport`, all within `lib/store` plus
`app/api/reconcile/route.persistence.test.ts`. **No production consumer constructs a
`LedgerReport`** — the tamper drill only calls `verifyLedger` and reads `.ok`
(`tamper-drill.ts:751, :782`), so the newly-required `anchored` field breaks nothing. Confirmed
by 272/272 drill cases and 468 tests green.

Low blast radius. The required-field change is source-compatible for every in-repo consumer.

## Adversarial pass

Threat model: an attacker with **write access to the sqlite file** (the repo's stated model).

| Attack | Result |
|---|---|
| Wipe and re-seal as empty | Caught by the anchor (count + root + head). Reported as **NOT intact**. |
| Edit a receipt, re-derive every leaf/link/head/root | Caught (root + head; count identical). Reported as **NOT intact**. |
| Delete the anchor file | Fails closed — exit 1, never an unanchored pass. |
| Truncate/corrupt the anchor file | Fails closed — `parseAnchor` throws, exit 1. |
| Supply an anchor with `rootCount > count` | Refused (`7ea5c8d`). Previously accepted and would have driven the extension check. |
| Supply a session-scoped anchor | Refused (`7ea5c8d`). Previously coerced to whole-store and verified against the wrong scope. |
| Invoke with `--anchor` and no value, or `--anchor=path`, or a stray `--help` | Exit 2/1/2 (`848982a`). Each previously produced a **silent unanchored pass at exit 0**. |
| Set `seenCount` arbitrarily | **NOT caught.** Outside the leaf by design, pinned as drill boundary `boundary-seen-count`, and served as an audit total by `stats()`. Documented limit, not a regression from this changeset. |
| Renumber `seq` preserving order | **NOT caught.** Declined deliberately in `99c27e0` with measured rationale. |

## Coverage limits (stated honestly)

- The anchor's value rests entirely on **custody**, which no code here can enforce. An anchor kept
  beside the database is taken by whoever takes the database.
- `seenCount` and `seq` remain outside both the leaf and the anchor. Both are documented boundaries;
  neither is closed by this changeset and neither is claimed to be.
- No CLI-level automated tests exist for the exit codes. The three fail-closed paths were verified
  by hand (2 / 1 / 2) but are not locked by CI, so a regression would be silent.
  **Highest-value follow-up.**
- Concurrency: `verify-ledger` reads rows, `chain_state` and the uncommitted count in three separate
  statements with no snapshot. A concurrent append between them yields a spurious `count-mismatch`.
  Pre-existing, inherited by `anchorFromLedger`, fails safe (refuses to anchor).

## Verdict

**No HIGH-severity security finding in the changeset as it now stands.** Five real defects existed
mid-range and are fixed within it (`848982a`, `9f50b65`, `7ea5c8d`); the diff should be read as a
whole, not commit-by-commit — `99aa98a` alone would not pass this review.

Confidence: **high** on the anchored path (executed end to end against a real re-sealed database),
**medium** on the CLI surface (verified by hand, not locked by tests).
