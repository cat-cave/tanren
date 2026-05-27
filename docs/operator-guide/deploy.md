# Deploying Tanren

Phase 2A splits the single `compose.yml` into two profiles:

- `compose.dev.yml` — developer ergonomics. Static Vault root token, exposed host ports for Postgres, runner SSH, orchestrator HTTP, dashboard, and ntfy. No env variables required.
- `compose.prod.yml` — operator-provided secrets. No static fallbacks. No host-published port except the dashboard.

CI runs the dev profile. The Phase 1 fixture flow is unchanged.

Cloudflared tunnel exposure, TLS termination, and any other deployment hardening are deferred to Phase 3 (see `ROADMAP.md`).

## Dev quickstart

```sh
just up-dev          # builds and starts the dev stack
just smoke           # Phase 1 fixture smoke test (CI's gate)
just down-dev        # tears the stack down and removes volumes
```

`just compose-up` and `just compose-down` are kept as backward-compat aliases of `up-dev` / `down-dev`.

The dev profile reads `TANREN_GITHUB_OAUTH_CLIENT_ID` and `TANREN_GITHUB_OAUTH_CLIENT_SECRET` from your local env when present; if they are unset the orchestrator boots without the GitHub OAuth provider registered, matching pre-P2A-0003 behavior.

## Prod prerequisites

Before `just up-prod` will succeed, the operator must export:

| Env var | What it sets |
| --- | --- |
| `VAULT_ROOT_TOKEN` | Vault root token. The operator MUST rotate this away from the bootstrap value once the stack is healthy; see the rotation note below. |
| `POSTGRES_PASSWORD` | Password for the `tanren` Postgres user. |
| `TANREN_GITHUB_OAUTH_CLIENT_ID` | GitHub OAuth app client id used by `services/orchestrator/src/auth/githubProvider.ts`. |
| `TANREN_GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app client secret. Also written to Vault by `just vault-init-prod`. |
| `TANREN_PUBLIC_BASE_URL` | The absolute URL the orchestrator is reachable at; used to compute the OAuth redirect URI. |
| `TANREN_RUNNER_AUTHORIZED_KEY` | SSH `authorized_keys` line installed on the runner. |
| `TANREN_RUNNER_IDENTITY_PRIVATE_KEY` | Private key the orchestrator uses to SSH into the runner. |

Optional:

| Env var | Default | What it sets |
| --- | --- | --- |
| `DASHBOARD_HOST_PORT` | `3000` | Host port the dashboard publishes on. The only host-published port in the prod profile. |

Missing any required env causes `docker compose -f compose.prod.yml config` to fail with `variable is not set` referencing the specific variable.

## Port exposure (prod)

Only the dashboard publishes a host port. Postgres, Vault, the orchestrator HTTP port, the allocator sidecar, per-run runner SSH, and ntfy are reachable only on the internal docker network. The orchestrator's outward-facing surface is intentionally the dashboard; a future Phase 3 spec will add a reverse-proxied operator endpoint and (optionally) a cloudflared tunnel.

## Allocator sidecar (P2A-0010)

The Docker socket is mounted only into the `allocator` service. The orchestrator container no longer has any Docker access; it calls the allocator over HTTP on the internal docker network. Per-run runner containers are created and destroyed by the allocator; workspaces and `CODEX_HOME` are wiped on every release (success, failure, or TTL-driven abandoned reclaim). See `docs/operator-guide/runners.md`.

## Vault init flow

The prod Vault starts empty. Once per fresh Vault, the operator runs:

```sh
just vault-init-prod
```

That invokes `scripts/vault-init/run.sh prod`. The script:

1. Confirms Vault is reachable.
2. Enables the kv-v2 secrets engine at `secret/` if not already enabled.
3. Enables the AppRole auth method if not already enabled.
4. Creates per-service AppRoles (`orchestrator`, `allocator`) idempotently.
5. Writes the GitHub OAuth client id and secret at `secret/data/org/github/oauth/default`, matching the path P2A-0003's auth doc names (per-org overrides land in a later Phase 2A spec).

The script is idempotent: re-running it does not break an already-initialized Vault.

### Token rotation policy

The bootstrap `VAULT_ROOT_TOKEN` is a single-use credential. After `just vault-init-prod` succeeds and the stack is healthy, the operator should:

1. Issue a new root token via `vault operator generate-root`.
2. Revoke the bootstrap token (`vault token revoke <bootstrap>`).
3. Update the operator's secret manager so subsequent `up-prod` invocations use the rotated value.

Service AppRoles created by the init script have 1-hour token TTLs (24-hour max). Per-service token rotation is automatic from that point.

## CI

`.github/workflows/ci.yml` runs `just ci` (which calls `corepack pnpm run compose:config` against `compose.dev.yml`) followed by `just smoke` (which uses the dev profile). The prod compose file is validated by the architecture-checks script for the docker-socket and host-bind-mount invariants.

## Principled config bucketing

This deploy doc covers the secrets and host-port surface only. The broader principled config bucketing — which fields live in DB project/org config vs. `tanren-config` repo vs. compose env — is owned by P2A-0006 (`docs/operator-guide/project-config.md`) when that spec lands.

## What is not in this spec

- Cloudflared tunnel exposure (Phase 3).
- TLS termination (Phase 3).
- A sealed (non-dev-mode) Vault. The prod profile still starts Vault in dev mode but with no static token; replacing it with a sealed Vault is a Phase 3 hardening task.
- Per-org GitHub OAuth client id/secret overrides. P2A-0003 names the path shape; this spec only writes the `default` org value.
