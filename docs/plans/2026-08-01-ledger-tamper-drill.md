# Ledger tamper drill — vertical slice plan (2026-08-01)

## Goal

The persisted ledger already carries a hash chain and ships a verifier
(`lib/store/verify-ledger.ts`). "Tamper-evident" is currently proven by **eleven hand-written
example tests**. An example test proves the tampers its author thought of; it says nothing about
the tampers they didn't.

This slice turns the claim into a **drill**: a scripted adversary that mutates a *copy* of a real
ledger many distinct ways from a seeded generator, and an **invariant** — *for any tamper drawn
from the in-model space, `verifyLedger()` must FAIL* — plus a mandatory **negative control**: an
untampered ledger must PASS. A drill whose verifier rejects everything proves nothing.

Scope discipline: this is a vertical slice. It is the drill, the defects the drill finds, the
fail-closed fixes for those defects, a committed report, and a CI gate. It is **not** an external
anchor / signature scheme (see "Out of model" below).

## Adversary model

The adversary has arbitrary write access to the sqlite file — `sqlite3 receipts.db "UPDATE ..."` —
which is exactly the threat the chain exists to answer.

**In model** (must be caught, 100%): any mutation of `receipts` rows, and any *partial* mutation of
`chain_state` (rewriting a commitment without re-deriving every other commitment from the rows).

**Out of model** (documented boundary, pinned by a test that asserts the verifier PASSES): a
**full re-seal** — the adversary recomputes leaves, chain and every scope commitment so the file is
a valid ledger of a different history. This is undetectable *from the file alone* by construction;
`docs/VERIFICATION.md` already states it, and detecting it needs an off-box anchor. The drill pins
the boundary rather than pretending the boundary isn't there. Same for `seenCount`, the mutable
replay counter the leaf deliberately does not cover.

A tamper that changes **nothing a reader would observe** is not a tamper and is not counted either
way (e.g. `balanced 0 → 2`: both the verifier and `rowToStored()` decode it to `false`).

## Architecture

```
lib/store/tamper-drill.ts        the adversary: a registry of tamper CLASSES + a seeded runner
lib/store/tamper-drill.test.ts   the invariant + the negative control + the boundary pins
lib/store/tamper-drill-cli.ts    npm run drill:tamper -- <db> [--report <md>]  (exit 1 on escape)
docs/TAMPER-DRILL.md             the committed, regenerated report (classes / caught / escaped)
.github/workflows/ci.yml         a CI step so an escape reddens the build
```

No PBT library exists in this repo (no fast-check / hypothesis) and this slice adds **no
dependency**, so the generator is a deterministic seeded PRNG (mulberry32) inside vitest. Every
case is reproducible from `(seed, class)`.

### Contract

```ts
runTamperDrill({ ledger, workdir, seeds }): Promise<DrillReport>
```

- `ledger` is **copied per case**; a committed reference db is never mutated in place.
- A class `apply()` returns a description, or `null` when it cannot apply to that ledger (skipped,
  never silently counted as caught).
- `DrillReport.ok` ⇔ control passed ∧ every in-model case was caught ∧ every boundary case behaved
  as pinned. One consistent shape; the CLI's exit code is derived from it.

## Misuse-resistance probe (misuse-resistance)

The NULL-chain evasion fixed in Phase 0 is an instance of *"a verification function that SUCCEEDS
on malformed input"*. The drill systematically probes for siblings: for every field the verifier
reads, what happens on zero / empty / null / negative / wrong-type? **A check that gets SKIPPED
rather than FAILED is the defect.** Any such path must fail closed.

## Tasks (TDD, bite-sized)

1. **Plan doc** (this file), committed.
2. **RED**: `tamper-drill.test.ts` — negative control + the invariant over the class registry.
   Run it; capture the verbatim failure.
3. **GREEN**: `tamper-drill.ts` — seeded runner + ~20 tamper classes. Run; capture verbatim.
   Any class that escapes is a **real defect** — root-cause it before touching anything.
4. **Fix what the drill finds**, fail-closed, one test per defect, existing suite untouched.
5. **CLI + committed report + CI step.**
6. **Docs**: update `docs/VERIFICATION.md` so no doc claims more than the code does.
7. Full suite + typecheck + lint green; mutation-verify each new lock.
