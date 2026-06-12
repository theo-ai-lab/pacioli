# Run the real experiment → the headline number

The one statistic the provenance firewall reserves for real data: **how often agents actually misbehave.**
This kit turns it into an afternoon. Synthetic fixtures are the starting point; *this* is the real number.

## The loop

```bash
# 1. Run a real agent against a low-limit prepaid card, then log what it claimed vs. what the
#    confirmation actually showed (interactive; firewall-safe; provenance = self-run):
npm run capture

# 2. Validate the corpus + preview the rate it will publish (with a 95% confidence interval):
npm run capture:validate

# 3. That's it — the number renders automatically on /methods. No code change.
```

`dataset/captured.jsonl` is **gitignored** (it holds your real runs); the `/methods` page reads it at build
time and shows `pending` until real runs exist, then the rate, then the rate **with a Wilson confidence
interval** once you have ≥ 8 runs (e.g. "≈ 38% misbehaved · 95% CI 21–58%").

## How to run the agents (the protocol)

- See [`PROTOCOL.md`](./PROTOCOL.md) for the safe-envelope rules and [`agent-prompt.md`](./agent-prompt.md)
  for a paste-ready prompt that runs several agents for diversity.
- Use a **low-limit prepaid / virtual card** — never a primary card.
- Mix real spend tasks (the ones that produce the number) with no-spend controls.
- Target **≥ 10–30 real runs** for a number worth publishing; the more runs, the tighter the interval.

## The firewall (non-negotiable)

`captured.jsonl` may only contain **real** runs (`provenance: self-run` / `gmail`). The validator rejects any
`[SYNTHETIC]` excerpt and flags non-headline-eligible provenance. A fabricated row labeled real is the worst
possible contamination — it would turn Pacioli into the thing it detects.
