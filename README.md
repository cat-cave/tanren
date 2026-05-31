# Tanren

Tanren is the platform for end-to-end agentic code development.

This repository contains the v0 of Tanren v3. Phases 1, 2, and 3 are complete and
merged on `main`: a Docker Compose stack, typed Postgres schema, orchestrator with
a background **run worker** that drives a dashboard-triggered run end-to-end
(plan→write→check→audit→in-loop gate→draft PR→review→merge), the full operator
dashboard (DAG canvas, thick-Forge conversation, spec discovery, candidate inbox,
scheduled audits, `tanren-config` gate, greenfield + brownfield onboarding), thin
CLI, SSH runner substrate, a family of allocators (static/sidecar/manual-ssh/
Hetzner/DigitalOcean/GCP/AWS-EC2/Kubernetes), multi-harness providers
(codex/claude/opencode/aider behind a versioned harness protocol), pluggable secret
stores (Vault/GCP-SM/AWS-SM/1Password), multi-provider identity
(github_oauth/OIDC/Authentik/local_dev), per-org GitHub App connectivity, all nine
notification channels, a quota/admission + metering seam, a BYOK-vs-managed provider
toggle, and a hardened 15-step strictness gate.

A large multi-tenant + quality expansion has since merged on `main`:

- **Multi-tenancy is fully DB-enforced and live-validated end-to-end through
  runner allocation.** Postgres Row-Level
  Security enforces `org_id` isolation — a restricted `tanren_app` runtime role
  (NOBYPASSRLS), a narrow `tanren_system` BYPASSRLS pool for bootstrap/cross-org
  reads, and deny-by-default `USING`+`WITH CHECK` policies on every tenant table
  (migrations `0029`/`0030`; `db/src/orgScope.ts`). A live operator-driven run
  exercised it end-to-end (signup→CRUD→run→mTLS-claim→cred-resolution→runner-
  allocation) and caught+fixed a class of RLS-completeness bugs the hello-fixture
  smoke missed — each now regression-tested (`just smoke-rls-*`).
- **Control-plane/data-plane split P1→P3b.** A standalone `worker` deployable
  claims jobs over an mTLS control-plane endpoint and routes its run-state writes
  through control-plane `/internal/*` endpoints; it connects as the de-privileged
  `tanren_dataplane` role (migration `0031`) whose `events`/`cost_records` write
  grants are dropped (proven by a `42501` negative test).
- **Quality bars.** ~13 Stryker mutation clusters (71–98%) + a weekly full-repo
  mutation job (`mutation-weekly.yml`); oxlint warnings driven from ~3052 to ~5
  with ~25 rules flipped warn→error.

What is still genuinely pending/deferred: the **live demo close-out is paused at
the harness-integration frontier** — workspace git-clone / worker→runner SSH auth,
the real codex/claude/opencode write stage, and draft-PR → CI → Mergify merge (see
`docs/operator-guide/live-validation-findings.md`); the durable credential
registry; managed-hosting **P3c** + Vault per-run scoped credentials + allocator-
service org threading; the agy/pi/reasonix **live** harness validation (pi/reasonix
adapters built, agy deferred); the GitLab/VCS abstraction (deferred — GitHub-coupled
via Mergify/Actions); and the long-horizon Rust rewrite/native harness. The full
forward plan across all four dimensions is `docs/roadmap/forward-roadmap.md`; see
`ROADMAP.md` for the honest status.

The baseline `hello` workflow remains a synthetic smoke path, and the component live
smokes below still live-prove the real-agent loop: the orchestrator can load managed
credentials, allocate a runner, prepare a fixture repository workspace over SSH, run
Codex as Writer and structured Answerer, open a draft GitHub PR, poll CI, and persist
the result as inspectable run/task/event state.

## Local Smoke

```sh
corepack enable
pnpm install
corepack pnpm run check
just smoke
```

`just smoke` builds the orchestrator, dashboard, and runner images, starts Postgres, Vault, orchestrator, dashboard, runner, and ntfy, then verifies:

- `tanren doctor` (orchestrator / Postgres / Vault connectivity)
- direct runner SSH
- the live SSH integration test (the real SSH substrate)
- the real run path across the API↔worker process boundary (`smoke-plane-split-*`) + the RLS isolation proofs

The opt-in Phase 1 live proof requires a managed Codex auth bundle, a GitHub token file, and an owned fixture repository:

```sh
TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json \
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token \
TANREN_GITHUB_REPO_URL=https://github.com/cat-cave/tanren-fixture-easy \
just live-phase1-fixture
```

That command should leave a persisted run with `outcome = 'phase1_fixture_complete'`, `plan`, `write`, `check`, `audit`, and `ci` tasks all `done`, a draft fixture PR URL, and a `ci.passed` event.

To clean up the smoke stack:

```sh
just compose-down
```

If you are moving from an older local baseline, reset the local Postgres volume before the smoke:

```sh
docker compose -f compose.dev.yml down -v
```

The single `compose.yml` was split into `compose.dev.yml` (the current local baseline) and `compose.prod.yml` in P2A-0004. See `docs/operator-guide/deploy.md` for the prod profile and Vault init flow.

## Roadmap

`PROJECT_BRIEF.md` is the source of truth. `ROADMAP.md` records the completed Phase 0/1/2/3 work (and the merged multi-tenancy / plane-split / strictness / longevity expansion) plus the honest list of what remains pending or deferred. `docs/roadmap/forward-roadmap.md` is the single authoritative forward plan across all four dimensions (core run loop · pipeline experimentation · refactor/scale prepwork · managed-hosting).
