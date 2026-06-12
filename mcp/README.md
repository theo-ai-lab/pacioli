# Pacioli MCP server

Exposes the reconciliation engine as a single **read-only** [Model Context Protocol](https://modelcontextprotocol.io)
tool, so a live agent (Claude Desktop, the Claude CLI, any MCP host) can call Pacioli **mid-task** to self-issue a
receipt — double-entry bookkeeping for agents, in the loop instead of only post-hoc.

## The tool

```
reconcile_claim(agent, task, claim,
                budgetUsd?, mayPurchase?, mayRecur?, constraints?,
                merchant, amountUsd?, recurring?, recurringPeriod?, items?, date?, excerpt)
  → { verdict, balanced, findings[], deltaUsd?, likelyCause, receiptId: "sha256:…", receiptHash }
```

Deterministic; no API key, no network. `OVERSPEND` / `UNAUTH_RECURRENCE` / `SCOPE_CREEP` are exact;
`CLAIM_MISMATCH` (wording/constraint) is **abstained by design** — this tool never judges it. The LLM judge
lives in the app/HTTP API, not here; an MCP result with zero findings means "the deterministic rules found
nothing", not "the claim was verified".

## Run

```bash
npm run mcp          # stdio
npx tsx mcp/smoke.ts # end-to-end self-check (spawns the server, lists tools, calls reconcile_claim)
```

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
