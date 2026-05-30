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
notification channels, DB-enforced tenancy, a quota/admission + metering seam, a
BYOK-vs-managed provider toggle, and a hardened 14-step strictness gate.

What is still genuinely pending/deferred: the live demo + live cloud/SaaS
validation (need real credentials); the agy/pi/reasonix harnesses (await CLI
specs); the GitLab/VCS abstraction (deferred — GitHub-coupled via Mergify/Actions);
RLS + a control-plane/data-plane split (planned); and the long-horizon Rust rewrite/
native harness. See `ROADMAP.md` for the honest status.

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

- `tanren doctor`
- `tanren hello`
- `tanren status <run_id>`
- direct runner SSH
- the live SSH integration test

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

`PROJECT_BRIEF.md` is the source of truth. `ROADMAP.md` records the completed Phase 0/1/2/3 work (and the merged SaaS-priming / strictness / longevity expansion) plus the honest list of what remains pending or deferred.
