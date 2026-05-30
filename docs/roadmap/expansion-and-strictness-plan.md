# Expansion & Strictness Plan

Two standing tracks pursued autonomously after the Phase 3 build. Both built to
**code + mocked-tests + CI-green**; live validation (real cloud / SaaS creds)
remains deferred. Seam inventory + strictness baseline were mapped 2026-05-29.

**Status:** both tracks are **merged on `main`**, except the explicitly deferred
GitLab/VCS abstraction and the agy/pi/reasonix harnesses (await CLI specs). The
"Backlog" column below is retained as the original plan; the "Status" column
records what shipped.

## Track A — capability / connectivity expansion (clean adapter seams)

Each item is a new implementation behind an existing interface (new file +
register in the selector/registry + mocked-API tests) — **no core refactor**.

| Seam (interface)                                                                                         | Backlog (original)                                                                        | Status                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocators** — `engine/allocators` (`Allocator`, `AllocatorRouter`, `buildAllocator`, `AllocatorKind`) | DigitalOcean, AWS-EC2, Kubernetes (enum-scaffolded stubs → implement); **GCP** (new kind) | **DONE.** static/sidecar/manual-ssh/Hetzner/DigitalOcean/GCP/AWS-EC2/Kubernetes all implemented; enum-scaffold stubs are gone. Live-validate still needs cloud creds.                                                                                                                                            |
| **Inbox source connectors** — `engine/forge/inbox` (`SourceConnector`)                                   | **Sentry** (errors), Linear, Jira                                                         | **DONE.** GitHub Issues + Sentry + Linear + Jira connectors all present.                                                                                                                                                                                                                                         |
| **Agent-harness adapters** — `engine/providers/adapterSelector` (`cli` switch)                           | **agy** (antigravity CLI; replaces deprecated gemini CLI), aider, pi, reasonix, …         | **Partial.** Codex/Claude/opencode/**aider** done behind a versioned harness protocol. **agy / pi / reasonix still pending CLI specs.** Structured-output gate enforced: harnesses without structured JSON are WRITER-ONLY; answerer roles (plan/check/audit/discovery/forge) require structured output.         |
| **Notification channels** — `engine/notifications` (`NotificationChannel`, registry)                     | Teams, Discord, Email, Twilio, PagerDuty, Webhook                                         | **DONE.** All 9 channels (ntfy/slack/github-checks/teams/discord/email/twilio/pagerduty/webhook) have real adapters; each wires up when its deps/creds are supplied and falls back to `StubChannel` otherwise.                                                                                                   |
| **Identity providers** — `auth/**` (`IdentityProvider`)                                                  | **Authentik turnkey preset** (homelab self-hosting), Okta, Auth0, Keycloak                | **DONE (Authentik preset).** github_oauth + generic `OidcProvider` (P3-0030) + the **Authentik claim-mapping preset** (`TANREN_OIDC_PRESET=authentik`) + local_dev all ship; see `docs/operator-guide/oidc-authentik.md`. Okta/Auth0/Keycloak work via the generic OIDC env today; dedicated presets are future. |
| **Secret stores / cost resolvers** — `contracts/{secretStore,costResolver}`                              | AWS Secrets Manager, K8s secrets; custom pricing                                          | **DONE (secret stores).** Pluggable backends: Vault (default) / GCP Secret Manager / AWS Secrets Manager / 1Password via `buildSecretStore`. Custom cost-pricing resolvers remain lower-priority.                                                                                                                |

### Deferred (NOT a clean adapter) — GitLab / VCS-provider abstraction

GitHub is hardcoded across ~18 files (PR lifecycle, CI status, merge, clone/push
auth, App tokens, webhooks, repo-read), **and** the merge-integration (Mergify —
GitHub-org-only) and CI (GitHub Actions executing `tanren-ci.yml`) layers are
GitHub-coupled. Supporting GitLab/Gitea requires a `VcsProvider` abstraction +
merge-integration + CI-provider rework (~3–4 wk), not an adapter. **Deferred by
decision (2026-05-29) for later deliberate design.** Do not build blind.

## Track B — strictness & testing ladder (CI-self-validating)

**Status: DONE (waves 1–5).** The shared-config edits (`tsconfig.base.json`,
`oxlintrc.json`, `package.json`, `vitest.config.ts`,
`scripts/check-architecture.mjs`) all landed. The gate is now a 14-step
`just fast-check` (format-check, lint, types-lint, architecture, schema/state/
event/answerer/contract drift, knip, spelling, typecheck, test, compose-config).

1. **Wave 1 — DONE:** tsconfig `noUncheckedIndexedAccess` / `noImplicitOverride` / `noPropertyAccessFromIndexSignature` / `verbatimModuleSyntax` all on; oxlint `pedantic` + `import` plugin (`import/no-cycle`, `import/no-self-import`).
2. **Wave 2 — DONE:** `knip` dead-code check; coverage ratchet/floors; per-package typecheck.
3. **Wave 3 — DONE:** structural architecture ratchets (complexity/deep-import/params) in `scripts/check-architecture.mjs`.
4. **Wave 4 — DONE:** typed-lint (`just types-lint` → typescript-eslint `no-floating-promises` / `no-misused-promises` / `await-thenable`).
5. **Wave 5 — DONE:** prettier + commitlint + cspell, plus contract-schema-drift.
6. **Later (on-demand / nightly):** Stryker mutation testing (`just mutation`, deliberately not in `fast-check`); `exactOptionalPropertyTypes` (staged).

## Baseline (original, pre-expansion)

For the record, the starting point was: TS `strict: true` only (the above flags
off); oxlint correctness/suspicious/perf (no pedantic/import/typed-lint);
coverage thresholds on 6 workflow-critical paths only (no repo-wide/mutation); no
dead-code tool; format-check newline/whitespace only.

## Execution (as run)

Track B led (hardened the gate so subsequent autonomous work stayed safe), then
Track A clean-seam adapters fanned out under the stricter rules. Per-PR through
the CI gate; migrations + shared-registry edits serialized one-per-wave.
