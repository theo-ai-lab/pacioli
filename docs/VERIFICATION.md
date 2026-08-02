# How Pacioli is verified

The [README](../README.md#how-its-verified) carries the summary: the measured per-class table,
the reproduce commands, and a one-line-per-claim map of the machinery. This file is the depth —
the full account of each verification mechanism, and the exact contracts of every surface the
engine is exposed on. Nothing here is asserted that a command below doesn't reproduce.

## The one idea

"What the agent claimed" versus "what actually happened" is **prediction versus ground truth**. So
the reconciliation engine isn't something an eval is bolted onto — it *is* an eval, and it's
measured like one: per-class precision/recall over a labeled set, deterministic rules first, every
LLM judgment marked.

## The measured result

The deterministic engine, scored against the labeled fixtures. Precision is high where the engine
commits, because the rules are exact. Recall is the honest story.

| class | precision | recall | read |
|---|---:|---:|---|
| `OVERSPEND` | 1.00 | 0.92 | exact — a budget delta is a number |
| `UNAUTH_RECURRENCE` | 1.00 | 1.00 | exact — an authorization flag |
| `SCOPE_CREEP` | 1.00 | 0.80 | catches "spent when told not to", unrequested add-ons, violated "do not send" |
| `CLAIM_MISMATCH` | — | 0.00 | **abstained by design** → routed to the LLM judge |

Two things this table is *not* hiding:

1. **`CLAIM_MISMATCH` recall is 0.** That's deliberate. Fuzzy claims ("cheapest", a wrong date)
   aren't something a deterministic rule should pretend to judge, so the engine abstains and hands
   them to a gated LLM judge that marks every finding `llm-assisted`. Run the 17 documented
   incidents through the engine and it abstains on almost all of them — because real-world agent
   failures are overwhelmingly claim-mismatches. That's the argument for deterministic-first: be
   exact where you can be, don't guess where you can't.
2. **There is no "agents misbehave X%" headline yet.** That number can only come from real runs
   commissioned against a live card (`self-run`/`gmail` provenance). A provenance *firewall* in
   the code forbids filling it with synthetic or third-party data. It is pending, on purpose. When
   the runs happen, raw captures stay private and `npm run capture:publish` emits their redacted
   projection (contract fields + a short no-PII excerpt) as the committed
   `dataset/captured.public.jsonl` — so the number will be re-scorable by a stranger, not taken
   on faith.

## Reproduce it

```bash
npm test          # the full suite — unit + property-based & metamorphic fuzzing of the engine contract
npm run eval      # the per-class table above, in the terminal
npm run fuzz      # 50,000 mutated cases against the formal invariants in SPEC.md

# the citable harness — Inspect AI (UK AISI). The TS engine is the classifier; this only scores it.
npm run eval:build
inspect eval eval/discrepancy_eval.py --model mockllm/model -T split=all -T seed=1234
```

## Verifiable by construction

The engine is treated as safety-relevant code, not a demo script.

### A formal contract

Behaviour is specified as 10 firing invariants **and 6 metamorphic relations** in
[`SPEC.md`](../SPEC.md), written as executable predicates
([`packages/engine/src/spec.ts`](../packages/engine/src/spec.ts),
[`lib/engine/metamorphic.ts`](../lib/engine/metamorphic.ts)) — the numeric invariants re-derived
independently of the engine, the scope sub-rules a single shared module by design (so contract and
engine cannot drift), with an independent rules-as-data mirror
([`lib/engine/rules-dsl.ts`](../lib/engine/rules-dsl.ts)) cross-checked against the engine over
thousands of fuzzed inputs.

### Property-based + metamorphic fuzzing

A seeded fuzzer mutates inputs against the rule boundaries — **100,000 cases, zero violations**
(`npm run fuzz -- 100000`; the default run and CI use 50,000) — checking both the firing contract
and relational truths (more money charged can't fix an overspend; raising the budget can't create
one; granting authorization can't add findings). Runs in the test suite and on every build
(`npm run fuzz`).

### Diagnosis, not just detection

Each finding carries ranked, deterministic root-cause hypotheses ("+$78 → likely an undisclosed
seat fee + add-on") — closer to a black-box recorder than a tripwire
([`packages/engine/src/hypotheses.ts`](../packages/engine/src/hypotheses.ts)).

### Tamper-evident, auditable receipts

Each receipt is content-addressed (SHA-256 over its claim, evidence, and verdict) and batched into
a **Merkle audit trail**: one root commits to a session, and an inclusion proof shows a receipt
belongs to it *without revealing the others* — selective transparency, no SNARK
([`packages/engine/src/merkle.ts`](../packages/engine/src/merkle.ts)).

**What that does and does not cover.** A content hash proves a receipt's contents match its id. On
its own it proves nothing about the *ledger* those receipts sit in — a row edited, deleted or
reordered straight against the database file would still hash correctly, because nothing committed
to its position. So the durable store is a chain, not just a table
([`lib/store/ledger-chain.ts`](../lib/store/ledger-chain.ts)): each persisted row carries a
`leafHash` over its immutable facts, the `prevHash` of the row before it, and
`entryHash = chainHash(prevHash, leafHash)`; each scope — the whole store, plus every session ledger
— commits a count, a head, and a Merkle root over its leaves.

> **What a verification establishes, in one sentence.** `npm run verify:ledger` proves that the file
> in front of you is **internally self-consistent** — every row still hashes to the leaf committed for
> it, every link holds, and every scope's count, head and Merkle root match the rows that survive —
> and it **cannot, from the file alone, establish that nobody re-sealed the whole ledger**, because a
> file rewritten end to end is internally self-consistent too. Telling those two apart requires a
> commitment made *before* the rewrite and kept *outside* the file (an off-box copy of a root, or a
> signature over one). Without such an anchor, a passing verification is a statement about integrity
> since the last seal — not a statement about authorship.

| a change made directly to the sqlite file | caught by |
|---|---|
| a historical row edited in place | its `leafHash` no longer matches its contents |
| a row deleted, or two rows reordered | the next row's `prevHash` no longer links |
| the newest rows truncated | the scope's committed count and head |
| a row inserted with forged chain values | both of the above |
| a row inserted with the chain columns left empty | the rows carrying no commitment are RECOUNTED, never taken from the stored counter |
| a session's whole ledger forged in | it has receipts but no committed chain state |
| a session ledger committed to *zero* receipts | a scope can't commit to nothing: the store deletes a session's chain state when its last row goes |
| two rows colliding on one sequence number | `seq` is the walk's order, so it must BE an order — otherwise the chain is checked against a tie-break |
| a row stored in a non-canonical encoding (text in `deltaUsd`, padded `findingTypes`, a verdict outside `{0,1}`) | the row→facts decode is injective, so "the leaf matches" still implies "the row is what was committed" |
| a committed counter that isn't a number (`rootCount = -9`, `rootCount = 'x'`) | counters are validated *before* anything is inferred from them — a check that can't be run FAILS, it is never skipped |
| a position pushed outside the safe-integer range (`seq += 2^53`) | the row read fails before a row exists to decode, so the failure is caught and **located** — a verifier that dies is not a verifier that reports; the store's allocator refuses to write into that range too, by name |

Covered honestly means covered *exactly*: the leaf commits to `receiptId`, `receiptHash`,
`balanced`, `findingTypes`, `agent`, `merchant`, `deltaUsd`, `createdAt` and `sessionKey` — and to
nothing else. Two columns of every stored row are outside it, both deliberately.

The first is `seenCount`, the mutable replay counter that a re-submission bumps in place: the chain
commits to the immutable facts of each distinct receipt, not to how many times one was replayed.

The second is **`seq`, the row's position — and only its *relative order* is load-bearing.** `seq`
orders the verifier's walk, orders a scope's leaves and picks a retention prune's victims, but every
one of those uses is relative, and the relative order is already committed to by `prevHash`/
`entryHash`. So renumbering every position while preserving their order (`UPDATE receipts SET seq =
seq * 2`) is **undetectable — and inert**: measured on copies of the committed reference ledger, the
renumbered file still verifies (`ok`, no faults), a real prune driven through the store API afterwards
destroys the *same* rows and spares the *same* survivors, and every leaf, link, head and root is
byte-identical to the pristine run. The only value that moves anywhere in the file is
`chain_state.prunedSeq`, which is written, carried forward, and never read back as a decision by
anything. A renumbering that does **not** preserve the order is a different attack and is caught
(`chain-break`, or the strict-increase check that also rejects duplicate and NULL positions).

**We consider that acceptable, and the reason is that no decision depends on the value.** It is
asserted rather than assumed: `boundary-seq-renumber` pins it in the tamper drill, and two seeded
property tests in [`ledger-chain.test.ts`](../lib/store/ledger-chain.test.ts) assert over a *space* of
24 generated order-preserving renumberings that the ledger still verifies, that every commitment is
unchanged, and that a real prune destroys exactly the same rows. **Decision, recorded rather than
left silent: `seq` is deliberately NOT added to the leaf facts.** Doing so changes every leaf hash in
existence — the committed `dataset/reference-ledger.db` stops verifying immediately (measured:
`[row-altered] seq 1 (sha256:0f3c1a2b4d5e6f70)`) and every deployed store would need regenerating —
to close an exposure that cannot alter a verdict, a survivor set, or a commitment. If a future change
ever makes seq's absolute value load-bearing, those property tests go red and this paragraph gets
rewritten instead of quietly going out of date.

One place where "inert" stops: pushing a position past 2^53 while still preserving the order is a
**denial of service, not a forgery**. `seq` is an int64 in the file but a JS number everywhere it is
read, and `node:sqlite` will not narrow an integer that wide — so both halves have to fail loudly,
and both now do.

*Reading.* The verifier reports a *located* `malformed-row` naming the receipt and the position
(the offenders are re-read as TEXT, which never crosses the number boundary), instead of dying with
a bare `RangeError` that names nothing — a verifier that dies is not a verifier that reports. Pinned
by the `malformed-seq-past-readable-range` drill class.

*Appending.* The store allocates the next position through
[`nextPosition()`](../lib/store/ledger-chain.ts), which reads `MAX(seq)` as TEXT and **refuses by
name** — a `LedgerPositionError` carrying a typed `reason` (`malformed-max`, `unreadable-max`,
`exhausted`), the ledger's current highest position, and the remedy — rather than failing by
arithmetic accident. Nothing is written, `save()` rejects, and `/api/reconcile` answers
`stored: false` with that line in the log. Every position it *does* return is one the store can read
again: never a position past the readable range (`MAX(seq)` already at `Number.MAX_SAFE_INTEGER`
used to allocate 2^53, write it, and report success — leaving a row the file could no longer verify),
and never `NaN`, which binds into sqlite as `NULL` and would put a row outside the order the chain is
walked in. Refused, the receipt is simply not stored: the ledger it declined to extend still verifies,
and every receipt already in it still reads. Pinned on the real store API — three cases and a seeded
property over 24 generated maxima — in [`ledger-chain.test.ts`](../lib/store/ledger-chain.test.ts),
and end to end at the HTTP surface in
[`route.persistence.test.ts`](../app/api/reconcile/route.persistence.test.ts).

That is the honest split: integrity holds, availability is what an attacker with write access can
take — and what they take is loud at both ends.

Three further limits, stated rather than buried: receipts written *before* the chain
existed carry no commitment and the verifier refuses to certify them instead of passing them
silently; bounded retention legitimately prunes the oldest rows, so a prune is **recorded** (the
chain keeps the last pruned entry as its anchor and the affected scopes re-seal) rather than left
looking like an attack; and the chain proves *internal consistency*, not authorship — an attacker
who can rewrite the whole file, chain and all, produces a self-consistent ledger. Detecting that
needs an external anchor (an off-box copy of the root, or the optional ML-DSA-65 signature over it),
which is why the roots are exposed rather than kept internal.

Retention has a sharp edge worth naming, because it follows from the second and third limits
together: an attacker who deletes the **oldest** receipts and re-anchors the chain the way a prune
does is indistinguishable, *from the file alone*, from bounded retention doing its job — that is what
it means for pruning to be legitimate. What still bounds it: the pruned range must be a **prefix**
(nothing can be lifted out of the middle without breaking a link), and any off-box copy of an older
root contradicts it immediately. All five boundaries — `seenCount`, an order-preserving `seq`
renumbering, a full re-seal, a wiped ledger, and this prefix prune — are **pinned by the drill** as
cases that must still verify, so if one ever starts failing, this paragraph gets rewritten
deliberately instead of quietly going out of date.

```bash
npm run verify:ledger -- receipts.db      # exit 0 verified · exit 1 with the located fault
```

The verifier opens the database **read-only**, walks every link from genesis to head, and names the
scope, sequence number and receipt id of the first fault
([`lib/store/verify-ledger.ts`](../lib/store/verify-ledger.ts)). CI runs it on every push against a
committed reference store (`dataset/reference-ledger.db`), so this is a continuously re-proven gate
and not a one-time assertion.

### The drill

A verifier is only as good as the attacks it has actually been run against, and a list of example
tests only ever contains the attacks its author thought of. So the claim is **drilled**: a scripted
adversary with write access to the sqlite file mutates a *copy* of that same reference store, one
tamper class at a time, with targets drawn from a seeded generator, and the invariant is that
**every** one of them fails verification — held up against a **negative control** (an untampered copy
must still verify), because a verifier that rejects everything proves nothing.

```bash
npm run drill:tamper                      # exit 0 all caught · exit 1 naming the escape
```

**34 in-model classes · 272 cases · 272 caught · 0 escapes**, re-run on every push and published as
[`docs/TAMPER-DRILL.md`](TAMPER-DRILL.md), which CI regenerates and holds to a byte-for-byte diff.
Adding a class to the registry in [`lib/store/tamper-drill.ts`](../lib/store/tamper-drill.ts) extends
the invariant automatically.

The drill is not decoration: on its first run it escaped in 51 of 264 in-model cases across seven classes,
tracing to four root causes, all of them instances of one API failure mode — *a verification function
that SUCCEEDS on malformed input*, the same class as the NULL-chain evasion that preceded it. A duplicate `seq` left every link
holding (`ORDER BY seq` resolved the tie by rowid) while handing an attacker the choice of which row
bounded retention deletes next; `rootCount = -9` or `'x'` retired a scope's Merkle commitment
entirely, because `NaN > n` is false and `slice(0, -9)` quietly returns `[]`; and a lossy row decode
let text in `deltaUsd`, padded `findingTypes` and a verdict outside `{0,1}` all hash as something
else that was committed. Every one of those now fails closed, and the last four rows of the table
above are the locks.

Signed, hash-chained agent receipts are themselves prior art
([Pipelock](https://github.com/luckyPipewrench/pipelock), [Acta](https://github.com/VeritasActa/Acta),
in-toto/Sigstore) — Pacioli's contribution is the *reconciliation* a receipt commits to, not the
receipt format. See [`RELATED_WORK.md`](RELATED_WORK.md).

### The deterministic fast path is falsifiable

Trusting the cheap rules and escalating only the residual to the LLM judge should give the *same
verdict* as running the judge on everything — so Pacioli measures it, it doesn't assume it. **Over
48 labeled fixtures the deterministic tier resolves ~40% of claims with zero escalation and a
verdict provably identical to judge-on-everything — 0 lossless violations, versus 25 for the
deliberately lossy never-escalate baseline — at zero model spend**
(`npm run reconcile -- --equivalence`). The equivalence relation (EQUIV-CASCADE; regime model-free
→ model-based, residual locus the claim) is committed into the same Merkle audit trail as the
receipts it summarizes, so the claim is itself tamper-evident. The same CLI ships a keyless
sample-k saturation curve (`--saturation`) and a conformal-calibrated residual band (`--conformal`)
— both deterministic, both zero model spend ([`lib/engine/cascade.ts`](../lib/engine/cascade.ts)).

### The judge distills into the deterministic floor — holdout-gated

Some of the residual is structurally obvious (the merchant evidence literally says "booked a
connecting flight *instead*"). Pacioli runs a judge **jury** over the residual, and where the jury
reaches a high-consensus agreement it *distills* that into a candidate deterministic rule — but
only PROMOTES the rule if it predicts the **ground-truth label out of sample**: each candidate is
**holdout-gated** on a slice it was not derived from and must hit the gold precision floor, or it
is rejected. The jury can be *fooled* (a clean claim that merely sounds suspicious); the gold
holdout gate is the stronger check that catches it and drops the rule. Over the 48 labeled
fixtures the keyless mock jury promotes one rule (`evidence-divergence-language`), **rejects a
second** that the jury agreed on but gold disproves out of sample, and never proposes a third —
moving deterministic coverage **39.6% → 54.2%** and the residual judge-call rate
**60.4% → 45.8%** at a **24% replaceable fraction** (20% out-of-sample). The jury reports
**correlation-corrected effective votes** (2.58 of 4, not the member count — a chorus of clones
cannot manufacture consensus), and every promoted rule is Merkle-receipted with its full
jury-consensus provenance (`npm run distill`;
[`lib/engine/jury.ts`](../lib/engine/jury.ts) ·
[`lib/engine/distill.ts`](../lib/engine/distill.ts) ·
[`lib/engine/distill-receipt.ts`](../lib/engine/distill-receipt.ts)). With a key, `--judge` seeds
a real LLM jury; with none it falls back to the keyless mock and says so.

### A selective-risk certificate on the residual judge

A selective judge abstains on the claims it is unsure of and commits a verdict only on a confident
*accepted* region; its **selective risk** is its error rate there. Pacioli prints a
**distribution-free upper confidence bound** on that risk for unseen claims — the exact-binomial
(Clopper–Pearson) route, distribution-free conditional on exchangeability. This is the
selective-risk-certification framing of
[Akter, Shihab & Sharma (arXiv:2509.12527)](https://arxiv.org/abs/2509.12527); we deliberately
take the distribution-free binomial route rather than print a PAC-Bayes constant, because **at N
in the tens an honest bound is WIDE, not a headline.** With one observed error in ten confident
flags the 95% bound is ~39% (vs a 10% point estimate) — so the deliverable is the **methodology
and the convergence**: the certificate WIDTH shrinks as O(1/√N), displayed as a width-vs-N curve,
and we never quote the small-N number as the judge's accuracy (`npm run certify`;
[`lib/engine/selective-risk.ts`](../lib/engine/selective-risk.ts)).

### The judge is a measured instrument

A calibration harness ([`lib/engine/judge-eval.ts`](../lib/engine/judge-eval.ts)) scores it
against human labels (TPR/FPR, precision/recall, Cohen's κ), reports rates as Wilson **confidence
intervals** not points, and runs a positional-bias probe — ready the moment a key and labels
exist.

### Externally grounded

Run against the 164 real airline + retail tasks of
[τ²-bench](https://github.com/sierra-research/tau2-bench) (Sierra, MIT), the engine produces
**zero false positives** on the in-scope reference trajectories (`npm run bench:tau2`). Honestly
scoped — a specificity check, not a τ²-bench score; see [`bench/tau2/`](../bench/tau2).

### CI re-proves it

A GitHub Actions workflow runs typecheck + lint + tests + ledger audit + fuzz + eval + build (plus
the Inspect harness and the deploy-parity data probe against a locally started instance) on every push — the eval is a regression gate, not a one-time claim. The eval snapshot
([`eval/RESULTS.md`](../eval/RESULTS.md)) must reproduce byte-for-byte
(`npm run eval:snapshot && git diff --exit-code eval/RESULTS.md`), and a separate job packs
`@pacioli-app/engine`, installs the tarball into a fresh consumer directory, and holds the CLI to
its documented contract (`npm run smoke:install`) — installability is re-proven continuously too.

## Surface contracts

The exact behaviour behind each row of the README's
[surfaces table](../README.md#one-engine-every-surface).

### HTTP API

`POST /api/reconcile` takes the claim + evidence and returns the verdict, the typed findings, and
the tamper-evident receipt id. Deterministic by default; pass `"judge": "auto" | "local" |
"anthropic"` to also run the LLM judge — **judge selection is only honored for authenticated
callers** (set `PACIOLI_API_KEY`, send `x-api-key`; constant-time compared), is rate-limited with
a daily cost ceiling, and the response's `judgeMode` tells you the truth: `off`, `unauthorized`,
`unavailable` (requested backend can't run — never disguised as "ran clean"), `error`, or the
backend that ran. Note the split: `balanced` and `findings` are always the **deterministic**
verdict (that is what the receipt hash commits to); judge results arrive separately as
`judgeFindings` — if you enable a judge, gate on both. A 200 also carries **`stored`**: whether the
receipt reached the durable ledger. A failed write does not fail the reconciliation (the verdict
stands, and the receipt is content-addressed so it can be re-submitted) but it is never hidden —
`stored: false` means the ledger does **not** have this receipt, and on a batch it means *no claim in
that batch* may be assumed filed. `POST /api/ingest` reports the same field. Bodies are byte-capped
at the transport (413 past 64KB, even chunked). Errors: `400` bad JSON · `401` bad key ·
`413` too large · `422` invalid shape · `429` judge rate-limited.

### Prometheus metrics

`GET /api/metrics` (honors the same key) exposes `pacioli_reconciliations_total` (true event
counter — replays of the same content-addressed receipt each count), `pacioli_receipts_unique`,
`pacioli_receipts_flagged`, `pacioli_findings_by_type{type=…}`, and
`pacioli_store_info{backend=…}` so you can see whether you're on durable `sqlite` (set
`PACIOLI_DB=/path/receipts.db`) or the in-memory fallback. The deployed demo sets no `PACIOLI_DB`,
so it runs the in-memory store **by design** — receipts are per-instance and reset on each deploy;
`backend="memory"` on the live `/api/metrics` is the honest reading, not a failure.

### Deploy parity

`GET /api/version` reports the exact commit a deployment serves (`{ sha, builtAt, version }` —
deliberately unauthenticated, so anyone can check it). The sha is captured by `npm run deploy`
**before** the source leaves the machine
([`scripts/predeploy.mjs`](../scripts/predeploy.mjs), which refuses a dirty tree — a remote build
has no `.git` to ask). A separate
[deploy-parity workflow](../.github/workflows/deploy-parity.yml) curls the live demo on every
push to `main` and weekly: a deployed sha that isn't `main`, or any route the README names going
missing, is a red X — a stale deploy can't silently falsify the demo links.

That much is still only status codes, and **a 200 proves nothing** — a deployment can serve every
route above and reconcile wrongly. So parity is also asserted on **data**: the workflow posts a known
fixture at `POST /api/reconcile` and holds the answer to the verdict that fixture must produce —
flagged, `OVERSPEND`, `deltaUsd` +78.40, and the finding citing *both* the claim line and the
evidence line ([`scripts/parity-probe.mjs`](../scripts/parity-probe.mjs)). The deployed URL is just
`BASE`: CI runs the identical probe against a locally started instance on every push, and a unit test
ties the fixture's expected verdict to what the engine actually produces, so the assertion can't
drift into checking a guess.

### CI gate (SARIF / JUnit)

`npm run audit -- --gate corpus.jsonl` reconciles a JSONL corpus of claim/evidence pairs and exits
non-zero if any claim is flagged — drop it into CI to fail a build on agent misbehavior.
`--format sarif` (default) uploads as a GitHub code-scanning report; `--format junit` feeds any
JUnit consumer; `--out file` writes the report to disk. Malformed rows warn loudly **and fail the
gate** — a skipped row is an unaudited claim, never a silent pass.

### MCP server

Pacioli ships a [Model Context Protocol](https://modelcontextprotocol.io) server, so an agent
(Claude Desktop, the Claude CLI) can call it **mid-task** to self-issue a receipt — double-entry
bookkeeping in the loop, not just post-hoc. Three read-only tools over the same deterministic
engine: `reconcile_claim` (one-shot), plus `reconcile_pr` and `reconcile_stream` for evidence that
arrives **incrementally** (a PR's diff stats → CI, or a confirmation that lands field by field) —
they report the earliest prefix at which a verdict is monotone-safe to commit (flag an oversized
agent PR as `OVERSPEND` before CI even finishes). See [`mcp/`](../mcp).

```bash
npm run mcp                                # stdio (tools: reconcile_claim, reconcile_pr, reconcile_stream)
npx tsx mcp/smoke.ts                       # end-to-end self-check
npm run reconcile:pr -- --gate < pr.json   # the PR adapter as a CLI gate — exit 1 on a flagged agent PR
```

### Framework adapter

[`lib/integrations/langchain.ts`](../lib/integrations/langchain.ts) is a dependency-free
`reconcileRun()` shaped for a LangChain/Agent-SDK callback — receipt an agent run mid-loop without
importing any framework.

### Parallel deterministic surfaces

Beyond the 4-class engine: line-item reconciliation (itemized prices must sum to the stated total
— [`lib/engine/line-items.ts`](../lib/engine/line-items.ts)), a tool-use auditor against an
allowlist/approval policy (OWASP-Agentic ASI02/03 —
[`lib/engine/tooluse.ts`](../lib/engine/tooluse.ts)), and a pre-deploy agent-config scanner
([`lib/engine/config-scan.ts`](../lib/engine/config-scan.ts)) that fails CI on un-capped budgets
or ungated dangerous tools.

### Optional hardening

`npm install @noble/post-quantum` activates ML-DSA-65 signing over the Merkle root
([`lib/engine/pqc.ts`](../lib/engine/pqc.ts)). The external-benchmark adapter
(`npm run bench:ale`, live data via `ALE_DATASET`) ingests any agent dataset with honest coverage
reporting, and `npm run bench:perf` benchmarks the engine with a latency regression gate.

## Limitations

Deliberately kept next to the claims they qualify: see
[Limitations & known failure modes](../README.md#limitations--known-failure-modes) in the README.
