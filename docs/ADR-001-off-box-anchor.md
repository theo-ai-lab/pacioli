# ADR-001: Detect a whole-ledger re-seal with an off-box anchor, not a better walk

## Status

Accepted

## Date

2026-08-02

## Context

`verifyLedger` walks the persisted receipt store and proves it is **internally
self-consistent**: every row hashes to its committed leaf, every link holds, and every
scope's count, head and Merkle root match the rows that survive.

That is strictly less than what a reader takes from the word it printed. An adversary
with write access to the sqlite file can edit a receipt and re-derive every leaf, link,
head and root, or delete every row and re-seal the result as an empty ledger. Both
outcomes are genuinely self-consistent, so the walk returns clean and the CLI printed
`VERIFIED`. The tamper drill has always modelled both attacks and classified them as
**boundaries** rather than pretending to catch them; `boundary-full-reseal-rewrite`'s
own description states the remedy: *"self-consistent, and only an off-box anchor can
tell."*

The gap was therefore known and documented, and the documentation was the only thing
holding it. Nothing in the code prevented a caller from reading a passing walk as
proof of authorship.

## Decision

Add an **anchor**: a commitment to the whole store's head, root and count, taken while
the record was trusted and kept somewhere the attacker does not control.

- `scripts`-level CLI `anchor:ledger` writes one. It **refuses to anchor a ledger that
  does not currently verify** — committing to a record an attacker has already worked
  on would freeze their work into the mechanism meant to detect it.
- `verifyLedger(path, { anchor })` compares and reports a located `anchor-mismatch`
  naming which of root, head and count diverged.
- An unanchored run prints `SELF-CONSISTENT … NOT ANCHORED` and sets `anchored: false`
  in the JSON report. **Two different claims no longer share one word.**
- An unreadable or malformed anchor **fails closed** rather than degrading into an
  unanchored pass — that degradation is precisely what an attacker who can delete the
  anchor file would want.

### Public interface changes (the reason this ADR exists)

| Surface | Change |
|---|---|
| `verifyLedger` | gains a second parameter `opts: { anchor?: LedgerAnchor } = {}` (backward compatible) |
| `LedgerReport` | gains required field `anchored: boolean` |
| `FaultKind` | gains `"anchor-mismatch"` |
| new module | `lib/store/ledger-anchor.ts` (`LedgerAnchor`, `anchorFromLedger`, `serializeAnchor`, `parseAnchor`) |
| new CLI | `npm run anchor:ledger -- <db> --out anchor.json` |

`anchored` is required rather than optional deliberately: an optional field lets a
consumer forget to check it and read an unanchored pass as an anchored one, which is
the exact confusion this ADR exists to remove.

## Alternatives considered

### Do nothing; keep the boundary documented

- Pros: no new surface; the limitation was already stated honestly in
  `VERIFICATION.md`, the drill and the README claim row.
- Cons: prose is not a control. The repo's thesis is that tamper-evidence is a
  *checkable* claim rather than an adjective, and the strongest attack on that claim
  was answerable only by reading a paragraph.
- **Rejected**: the whole point of this codebase is refusing that trade.

### Sign the ledger in place (e.g. ML-DSA over the head)

- Pros: no second artifact to keep.
- Cons: the signing key must live somewhere. An attacker with file-write access to the
  box very often has the key too, and then re-signs the forged ledger. It moves the
  custody problem without solving it, while adding a crypto dependency.
- **Rejected**: same custody problem, more machinery.

### Publish roots to an external transparency log

- Pros: strongest possible custody; a third party holds the commitment.
- Cons: a network dependency and an operational relationship, for a tool whose entire
  verification path is currently offline and dependency-free.
- **Deferred, not rejected**: the anchor format is a plain JSON commitment, so
  publishing it to such a log later is an operational choice, not a redesign.

### Add `seq` to the leaf so a renumbering is caught

- Considered during the same investigation and **declined** — recorded in commit
  `99c27e0`. It changes every leaf hash in existence (measured: the committed
  `dataset/reference-ledger.db` immediately fails with `[row-altered] seq 1`) to close
  an exposure that cannot alter a verdict, a survivor set or a commitment.

## Consequences

- **The security lives in custody, not in this code.** An anchor kept beside the
  database is taken by whoever takes the database. The code cannot fix that and does
  not claim to; it guarantees only that the distinction is never *silent*.
- The two re-seal classes remain listed as drill **boundaries**. That is what they are
  for the unanchored walk the drill runs, and promoting them would claim a detection
  the drill does not itself perform. The anchored path is proven separately in
  `lib/store/ledger-anchor.test.ts`.
- Consumers reading `LedgerReport` must handle the new required `anchored` field.
- An honest append past the anchor is reported as a mismatch until the operator
  re-anchors. This is deliberate: silently accepting any future the file happens to
  contain is the behaviour a re-seal exploits.
- `anchorFromLedger` refusing an unverifiable ledger means the anchor is only ever as
  good as the record was at the moment it was taken.
