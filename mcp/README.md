# Pacioli MCP server

Exposes the reconciliation engine as a single **read-only** [Model Context Protocol](https://modelcontextprotocol.io)
tool, so a live agent (Claude Desktop, the Claude CLI, any MCP host) can call Pacioli **mid-task** to self-issue a
receipt — double-entry bookkeeping for agents, in the loop instead of only post-hoc.

## The tools

Three read-only tools, all deterministic — no API key, no network.

### `reconcile_claim` — one-shot

```
reconcile_claim(agent, task, claim,
                budgetUsd?, mayPurchase?, mayRecur?, constraints?,
                merchant, amountUsd?, recurring?, recurringPeriod?, items?, date?, excerpt)
  → { verdict, balanced, findings[], deltaUsd?, likelyCause, receiptId: "sha256:…", receiptHash }
```

`OVERSPEND` / `UNAUTH_RECURRENCE` / `SCOPE_CREEP` are exact; `CLAIM_MISMATCH` (wording/constraint) is
**abstained by design** — this tool never judges it. The LLM judge lives in the app/HTTP API, not here; an
MCP result with zero findings means "the deterministic rules found nothing", not "the claim was verified".

### `reconcile_pr` — incremental, for an agent's pull request

```
reconcile_pr(title, author, body?, number?, task?, scope?, constraints?,
             mayModifyCode?, maxChangedLines?, claimsTestsPass?, claimedBehaviors?,
             additions?, deletions?, filesChanged?, touchedPaths?, checksPassed?, checksSummary?, merged?,
             policy?, k?)
  → { commitAt, committedClass, committedEarly, monotoneSafe, finalClass, finalVerdict, steps[], receiptId, … }
```

Reconciles what an agent's PR **claims** (implements X, stays within the agreed change size, review-only)
against evidence that lands over time (diff stats, touched files, CI). Reports the **earliest** prefix at
which a verdict can be committed — flag an oversized PR as `OVERSPEND` before CI even finishes — and whether
that early commit is monotone-safe. "Claims tests pass" vs a failing CI is the `CLAIM_MISMATCH` residual,
abstained here for the LLM judge.

### `reconcile_stream` — incremental, for any claim+evidence

```
reconcile_stream(agent, task, claim, …same fields as reconcile_claim…, revealOrder?, policy?, k?)
  → { commitAt, committedClass, committedEarly, monotoneSafe, finalClass, finalVerdict, steps[], receiptId, … }
```

Takes a complete claim+evidence, explodes it into a plausible arrival stream (header → amount → recurrence
→ line items), and reports how much evidence you actually need before a verdict is monotone-safe to commit.
The **final** verdict is identical regardless of arrival order — only the commit point moves.

Both incremental tools default to the **monotone-safe** policy (commit only when the class is
information-determined, or the stream ends); `policy: "stable-k"` commits earlier but is not monotone-safe.
The same surface is available on the command line: `npm run reconcile:pr -- --gate` (see [below](#cli)).

## Run

```bash
npm run mcp          # stdio
npx tsx mcp/smoke.ts # end-to-end self-check (spawns the server, lists tools, calls reconcile_claim)
```

## CLI

The PR adapter is also a standalone command, so the incremental engine is reachable without an MCP host:

```bash
npm run reconcile:pr                       # runs a clearly-labelled [DEMO] PR
npm run reconcile:pr -- --json < pr.json   # machine-readable run for { "claim": …, "evidence": … }
npm run reconcile:pr -- --gate < pr.json   # exit 1 if the final verdict is flagged — a CI gate for agent PRs
```

`pr.json` is `{ "claim": PullRequestClaim, "evidence"?: PullRequestEvidence }` (see
[`lib/adapters/pr-reconcile.ts`](../lib/adapters/pr-reconcile.ts)); piping is optional — a file arg works too.

## Add to the Claude CLI

```bash
claude mcp add --transport stdio pacioli -- npx tsx /ABSOLUTE/PATH/pacioli/mcp/server.ts
```

## Add to Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pacioli": { "command": "npx", "args": ["tsx", "/ABSOLUTE/PATH/pacioli/mcp/server.ts"] }
  }
}
```

Built on the production-current V1 SDK (`@modelcontextprotocol/sdk`), not the pre-alpha V2
(`@modelcontextprotocol/server`). Stdio servers must never write to stdout — Pacioli logs only to stderr.
