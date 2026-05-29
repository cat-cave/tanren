# Expansion & Strictness Plan

Two standing tracks pursued autonomously after the Phase 3 build. Both build to
**code + mocked-tests + CI-green**; live validation (real cloud / SaaS creds) is
deferred. Seam inventory + strictness baseline were mapped 2026-05-29.

## Track A — capability / connectivity expansion (clean adapter seams)

Each item is a new implementation behind an existing interface (new file +
register in the selector/registry + mocked-API tests) — **no core refactor**.

| Seam (interface) | Backlog | Notes |
|---|---|---|
| **Allocators** — `engine/allocators` (`Allocator`, `AllocatorRouter`, `buildAllocator`, `AllocatorKind`) | DigitalOcean, AWS-EC2, Kubernetes (enum-scaffolded stubs → implement); **GCP** (new kind) | Hetzner + manual-SSH done. Shared `buildAllocator.ts`/`poolPolicy.ts` → serialize. Live-validate needs cloud creds. |
| **Inbox source connectors** — `engine/forge/inbox` (`SourceConnector`) | **Sentry** (errors), Linear, Jira | GitHub Issues done. Each = config schema + `fetch()` + triage. |
| **LLM providers** — `engine/providers/adapterSelector` (`cli` switch) | Gemini, Mistral, local/OpenAI-compatible | Codex/Claude/opencode done. Add adapter + selector case + materializer. |
| **Notification channels** — `engine/notifications` (`NotificationChannel`, registry) | Teams, Discord, Email, Twilio, PagerDuty, Webhook | ntfy/slack/github-checks done; rest are `StubChannel`. |
| **Identity providers** — `auth/**` (`IdentityProvider`) | Okta, Auth0, Keycloak | Mostly config over the generic `OidcProvider`. |
| **Secret stores / cost resolvers** — `contracts/{secretStore,costResolver}` | AWS Secrets Manager, K8s secrets; custom pricing | Clean ifaces; lower priority. |

### Deferred (NOT a clean adapter) — GitLab / VCS-provider abstraction
GitHub is hardcoded across ~18 files (PR lifecycle, CI status, merge, clone/push
auth, App tokens, webhooks, repo-read), **and** the merge-integration (Mergify —
GitHub-org-only) and CI (GitHub Actions executing `tanren-ci.yml`) layers are
GitHub-coupled. Supporting GitLab/Gitea requires a `VcsProvider` abstraction +
merge-integration + CI-provider rework (~3–4 wk), not an adapter. **Deferred by
decision (2026-05-29) for later deliberate design.** Do not build blind.

## Track B — strictness & testing ladder (CI-self-validating)

Serialize the shared-config-file edits (`tsconfig.base.json`, `oxlintrc.json`,
`package.json`, `vitest.config.ts`, `scripts/check-architecture.mjs`).

1. **Wave 1 (in progress):** tsconfig `noUncheckedIndexedAccess` / `noImplicitOverride` / `noPropertyAccessFromIndexSignature` / `verbatimModuleSyntax`; oxlint `pedantic` + `import` plugin (`no-cycle`). Fix all fallout.
2. **Wave 2:** `knip` dead-code (ratchet); repo-wide coverage ratchet at measured baseline; per-package typecheck (`db/`, `cli/`).
3. **Wave 3:** new architecture checks — cyclomatic-complexity cap, cross-package deep-import ban, max-params.
4. **Wave 4:** typed-lint — typescript-eslint `no-floating-promises` / `no-misused-promises` / `await-thenable` (the type-aware gap oxlint can't cover).
5. **Wave 5:** prettier + commitlint + cspell.
6. **Later:** Stryker mutation testing (nightly job), `exactOptionalPropertyTypes` (staged), contract tests.

## Baseline (what exists today)
TS `strict: true` only (the above flags off); oxlint correctness/suspicious/perf
(no pedantic/import/typed-lint); coverage thresholds on 6 workflow-critical paths
only (no repo-wide/mutation); no dead-code tool; format-check is newline/
whitespace only; architecture checks per `scripts/check-architecture.mjs`.

## Execution
Track B leads (hardens the gate so subsequent autonomous work stays safe), then
Track A clean-seam adapters fan out under the stricter rules. Per-PR through the
CI gate; migrations + shared-registry edits serialized one-per-wave.
