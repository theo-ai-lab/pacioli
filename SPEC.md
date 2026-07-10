# Pacioli — Engine Specification (design by contract)

This is the **formal contract** for the deterministic diff engine (`packages/engine/src/diff.ts`). Each invariant is
stated here in plain language *and* encoded as an executable predicate in `packages/engine/src/spec.ts`. The numeric
invariants re-derive their conditions independently of the engine; the `SCOPE_CREEP` sub-rule predicates
(add-on / send-prohibition) are deliberately a SINGLE shared module (`packages/engine/src/scope-rules.ts`) imported by
both engine and contract so the two cannot drift — independence for that slice comes from the rule-DSL mirror
(`lib/engine/rules-dsl.ts`), which re-implements the numeric rules as data and is cross-checked against the
engine over thousands of fuzzed inputs. A property-based fuzzer (`lib/engine/fuzz.ts`) generates tens of
thousands of mutated inputs, runs the engine, and asserts every invariant below holds — so the implementation
is checked against the spec, not just against a fixed example set. Run it: `npm run fuzz` (or inside `npm test`).

Notation: `b = authorized.budgetUsd`, `a = evidence.amountUsd`, `tol = 0.02` (`TOLERANCE.budgetFraction`),
`floor = 1.0` (`TOLERANCE.budgetFloorUsd`).

## Preconditions
- The input conforms to `DiffInput` (`{ claim, evidence }`); `a` and `b` are a finite `number` or `null`.

## Invariants (each is checked by the fuzzer)

- **INV-OVERSPEND** — `OVERSPEND` is present **iff** `b` is a number, `b > 0`, `a` is a number,
  `a > b·(1+tol)`, **and** `a − b ≥ floor`. (A charge against a `$0`/no-budget authorization is never OVERSPEND —
  it's UNAUTH_RECURRENCE or SCOPE_CREEP.)
- **INV-RECURRENCE** — `UNAUTH_RECURRENCE` is present **iff** `evidence.recurring = true` **and**
  `authorized.mayRecur ≠ true`.
- **INV-SCOPE** — `SCOPE_CREEP` is present **iff** `evidence.recurring ≠ true` **and** at least one sub-rule
  fires: (a) *unauthorized spend* — `authorized.mayPurchase = false`, `a` is a number, `a > 0`; (b) *unrequested
  add-on* — an add-on product keyword (insurance, warranty, protection plan…) appears in `evidence.items`
  without an **un-negated** mention in the authorized text ("no trip insurance" is a prohibition, not a
  request); or (c) *violated send-prohibition* — the authorized text contains a "do not send"/"draft only"
  instruction and the evidence shows the send happened (word-bounded `sent|delivered`). Sub-rules (b)/(c) live
  in `packages/engine/src/scope-rules.ts`, imported by BOTH the engine and this contract so they cannot drift.
- **INV-ABSTAIN** — the engine **never** emits `CLAIM_MISMATCH`. That class is the LLM judge's residual; a
  deterministic rule must not guess at it.
- **INV-BALANCED** — `verdict.balanced = true` **iff** `verdict.findings` is empty.
- **INV-CITATION** — every `Finding` carries a non-empty `claimedRef` **and** a non-empty `actualRef` **and** a
  non-empty `note`. An uncited discrepancy is not representable.
- **INV-DETERMINISTIC-FLAG** — every engine `Finding` has `llmAssisted = false` (only the judge sets it true).
- **INV-DELTA** — `verdict.deltaUsd` is defined **iff** `a` is a number; when defined,
  `deltaUsd = round2(a − (b is a number ? b : 0))`.
- **INV-NO-DOUBLE-COUNT** — `SCOPE_CREEP` and `UNAUTH_RECURRENCE` are mutually exclusive on the recurring flag:
  if `SCOPE_CREEP` is present then `evidence.recurring ≠ true` (a free-trial-style charge is one finding, not two).
- **INV-DETERMINISM** — `diff(x)` is a pure function: two calls on the same input return byte-identical output.

## Metamorphic relations (checked by `lib/engine/metamorphic.ts`)
These constrain how the verdict must change when an input is *transformed* — domain truths the rules must
respect, fuzzed over the same generator:
- **MP-CHARGE-MONOTONE** — if `OVERSPEND` fires, charging *more* (larger `a`) keeps it firing. More money
  spent can never fix an overspend.
- **MP-BUDGET-MONOTONE** — within the positive-budget regime (`b > 0`), raising `b` never *introduces*
  `OVERSPEND`. (Raising a `$0`/negative budget to a positive one legitimately enables budget-checking.)
- **MP-AUTH-MONOTONE** — granting authorization (`mayPurchase`/`mayRecur` → true) can only *remove* findings,
  never add them: `findings(more-authorized) ⊆ findings(base)`.
- **MP-DELTA-SIGN** — `OVERSPEND` present ⟹ `deltaUsd > 0`.
- **MP-ADDON-MONOTONE** — appending an unrequested add-on item to the evidence can only *add* findings,
  never remove one: `findings(base) ⊆ findings(base + add-on)`.
- **MP-RECUR-DOMINANCE** — making the charge recurring means `SCOPE_CREEP` cannot survive (it yields to
  `UNAUTH_RECURRENCE` — the no-double-count rule, relationally stated).

## Integrity & evaluation (supporting contracts)
- **Content addressing** (`packages/engine/src/receipt-hash.ts`): a receipt's hash is SHA-256 over the canonical
  `{claim, evidence, verdict}`; any edit changes it.
- **Merkle audit trail** (`packages/engine/src/merkle.ts`): for receipt hashes `L`, `verifyProof(L[i], proof(L, i),
  root(L))` holds for all `i`; any change to a leaf changes `root(L)`.
- **Judge calibration** (`lib/engine/judge-eval.ts`): the judge is scored against human labels (TPR/FPR,
  precision/recall, Cohen's κ); rates are reported as Wilson confidence intervals, not points; a positional-
  bias probe asserts order-invariance.

## Severity contract (postconditions on each finding)
- `OVERSPEND.severity = high` if `a − b > 0.25·b`, else `medium` if `a − b > 0.10·b`, else `low`.
- `UNAUTH_RECURRENCE.severity = critical`.
- `SCOPE_CREEP.severity` by sub-rule: *unauthorized spend* = `critical` if `a ≥ 100` else `high`;
  *unrequested add-on* = `medium`; *violated send-prohibition* = `high`.

## Worked contract examples (Given / When / Then)
- **Given** `b=300, a=378, mayPurchase=true` **When** reconciled **Then** `OVERSPEND` (high), `deltaUsd=78`,
  `balanced=false`.
- **Given** `b=300, a=304` **When** reconciled **Then** `balanced=true` (within tolerance).
- **Given** `mayRecur=false, recurring=true, a=9.99` **When** reconciled **Then** `UNAUTH_RECURRENCE` (critical),
  no `SCOPE_CREEP`.
- **Given** `mayPurchase=false, a=329, recurring=false` **When** reconciled **Then** `SCOPE_CREEP` (high).
- **Given** `b=300, a=214, constraints=[nonstop]`, evidence shows one stop **When** reconciled **Then**
  `balanced=true` deterministically (the constraint mismatch is the judge's residual, not the engine's).

## Traceability
Spec clause → check: each `INV-*` above maps 1:1 to a predicate in `packages/engine/src/spec.ts::checkInvariants`, exercised
by `lib/engine/fuzz.ts` and asserted in `lib/engine/fuzz.test.ts`. The Given/When/Then examples map to cases in
`packages/engine/src/diff.test.ts`.
