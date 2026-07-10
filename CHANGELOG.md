# Changelog

All notable changes to Pacioli are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been tagged yet: `v0.1.0` (pending) will be the first tagged
release and will contain everything below. Dates in parentheses are the dates
the changes landed on `main`.

## [Unreleased]

### Added

- (2026-07-10) Capture publish path (`npm run capture:publish`): projects the
  raw private capture corpus (`dataset/captured.jsonl`, gitignored) down to the
  contract fields only, runs every free-text field through a PII redactor
  (emails, URLs, card/phone/confirmation numbers), validates every structured
  field against the contract (ISO date, finite money, enum
  sources/dimensions/severities), enforces the short-excerpt
  rule and the `[SYNTHETIC]` firewall, and emits the committed
  `dataset/captured.public.jsonl` — the redacted corpus that lets the deployed
  `/methods` page render the headline-eligible rows and lets a stranger
  re-score the rate. The dataset loader falls back to the published corpus when
  no raw captures exist. No capture runs have been made yet, so the file is
  absent and the headline rate remains honestly pending.
- (2026-07-10) Release workflow (`.github/workflows/release.yml`): fires only on
  version tags (`v*.*.*`); re-runs the gauntlet plus the install smoke at the
  tag, guards that the tag equals the engine package version, publishes
  `@pacioli-app/engine` to npm with provenance via OIDC trusted publishing (no
  long-lived token), and cuts the GitHub release. The npm-side trusted-publisher
  configuration is pending until the first release.
- (2026-07-10) CI install-smoke gate (`npm run smoke:install`): every push packs
  `@pacioli-app/engine` exactly as `npm publish` would, installs the tarball in
  a fresh consumer directory, `require()`s it and reconciles, and holds the CLI
  to its documented `--help` and exit-code contract — installability is
  re-proven continuously, not claimed once.
- (2026-07-10) The `pacioli` CLI, shipped as the bin of `@pacioli-app/engine`:
  `pacioli reconcile <input.json | -> [--json]` runs the deterministic engine
  over a `{claim, evidence}` input and prints the receipt; the exit code is the
  verdict (0 balanced, 1 out of balance, 2 error), so one command gates a
  pipeline.
- (2026-07-10) `@pacioli-app/engine` npm workspace (`packages/engine`): the
  zero-dependency deterministic core — `diff`, the typed contract, receipts,
  content addressing, the Merkle audit trail, and the executable invariant
  contract — extracted from `lib/engine/` into an installable package (CJS +
  types, Web Crypto only, Node 20+ and browsers). The app, CLIs, MCP server,
  and adapters now import it as `@pacioli-app/engine`. Not yet published to the
  registry (first publish pending; the bare name `pacioli` on npm belongs to an
  unrelated project, hence the scope).
- (2026-06-12) Pacioli v1 — claim-vs-evidence reconciliation for AI agents: the
  zero-dependency deterministic diff engine with the citation invariant enforced
  at the type level, SHA-256 content-addressed receipts, a Merkle audit trail,
  the executable invariant contract (`SPEC.md` + `checkInvariants`) with a seeded
  fuzzer, the labeled ground-truth dataset with a provenance firewall, the eval
  harness, and the Next.js demo app.
- (2026-06-14) Judge calibration CLI (Cohen's kappa for the gated judge over the
  engine's CLAIM_MISMATCH residual), `docs/RELATED_WORK.md`, and the
  reproduced-results snapshot `eval/RESULTS.md`.
- (2026-06-17 – 2026-06-18) Product loop and reachable engine surfaces: streamed
  judge UI, per-session ledger loop (`/ledger`, `/api/ingest`, `/api/ledger`),
  ingestion route, Steward agent, prefix reconciliation with the RECON-MR
  metamorphic relation, PR adapter (`npm run reconcile:pr -- --gate`), MCP tools
  `reconcile_pr` and `reconcile_stream`, `/api/reconcile` batch seam with a CORS
  allowlist, and an optional deterministic Plimsoll governor gate under the
  Steward.
- (2026-06-19) Falsifiable deterministic-first cascade: the EQUIV-CASCADE
  equivalence relation measured (not asserted) over the labeled corpus with
  telemetry, the keyless judge sample-k saturation curve, and a split-conformal
  calibrated residual band on CLAIM_MISMATCH; judge-jury distillation into the
  deterministic floor (correlation-corrected effective votes, holdout-gated rule
  promotion, Merkle-receipted provenance) and a selective-risk certificate
  (Clopper–Pearson upper bound) on the residual judge; reconcile CLI modes
  `--equivalence`, `--saturation`, `--conformal`, `--distill`, `--certify`.
- (2026-07-05) `/api/version` reporting the deployed commit, captured at
  deploy-prep time by `scripts/predeploy.mjs` (refuses dirty trees); the
  deploy-parity workflow — the live demo must serve `main`, with side-effect-free
  probes of the documented routes; `eval/RESULTS.md` made a machine-regenerated
  snapshot (`npm run eval:snapshot`) gated byte-for-byte in CI.

### Changed

- (2026-07-10) `/methods`, the capture docs, and the ignore files describe the
  redacted-publish path instead of "real captures are never committed": raw
  captures stay private, the redacted projection is what ships.
- (2026-06-18) README re-led as a product (How it works → Use it → Wire it into
  your pipeline → Ledger Report → Why this approach); the audit-rigor block moved
  into a later "How it's verified" section. Prose preserved, order changed.
- (2026-06-14) GitHub Actions bumped to latest majors (Node 24 runtime).
- (2026-06-20) Cascade alpha headline rounded honestly (~40%, matching the
  measured 39.6%).
- (2026-06-19) MCP smoke-test description corrected to all three tools;
  cross-origin batch caller example generalized in comments.
- (2026-07-06) Deploy-parity workflow comments describe the probe list precisely
  (README-named routes plus the API routes the demo pages call).

### Fixed

- (2026-06-12) Lockfile regenerated so `npm ci` validates across npm versions.
