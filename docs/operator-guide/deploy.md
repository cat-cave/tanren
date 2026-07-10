# Deploying Tanren

Phase 2A splits the single `compose.yml` into two profiles:

- `compose.dev.yml` — developer ergonomics. The Vault dev server's root token (`dev-root-token`) is supplied to the orchestrator + worker as a real `VAULT_TOKEN` **env value in the compose file** — the source code has NO `dev-root-token` fallback (managed-hosting dimension D: the orchestrator `main.ts` `require`s `VAULT_TOKEN` and fails hard if it is unset/blank). The **allocator has no Vault access at all** — it never resolves a secret value (runner credentials are delivered over the SSH file substrate by the orchestrator after allocation). Exposed host ports for Postgres, runner SSH, orchestrator HTTP, dashboard, and ntfy. No operator-provided env variables required (the compose file sets `VAULT_TOKEN` itself).
- `compose.prod.yml` — operator-provided secrets. No static fallbacks. No host-published port except the dashboard.

The broad `VAULT_TOKEN` is the orchestrator's bootstrap credential: it is used ONLY to read Vault health and to **mint per-run scoped child tokens** (a short-lived token whose policy grants `read` on exactly one run's credential ref paths). That broad token is never handed to a runner; each run's credential materialization reads through its own scoped child token (see the per-run-scoped-credentials seam, `engine/contracts/vaultTokenMinter.ts`).

CI runs the dev profile. The Phase 1 fixture flow is unchanged.

Phase 3 (P3-0030) hardens the prod profile: a cloudflared tunnel exposure profile, TLS-termination guidance, a Vault enterprise key-rotation-policy note, and Authentik OIDC as a second identity provider. Those are documented below.

## Dev quickstart

```sh
just up-dev          # builds and starts the dev stack
just smoke           # full local smoke/process-boundary/RLS gate
just down-dev        # tears the stack down and removes volumes
```

`just compose-up` and `just compose-down` are kept as backward-compat aliases of `up-dev` / `down-dev`.

The dev profile reads `TANREN_GITHUB_OAUTH_CLIENT_ID` and `TANREN_GITHUB_OAUTH_CLIENT_SECRET` from your local env when present; if they are unset the orchestrator boots without the GitHub OAuth provider registered, matching pre-P2A-0003 behavior.

## Prod prerequisites

Before `just up-prod` will succeed, the operator must export:

| Env var                             | What it sets                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_ROOT_TOKEN`                  | Vault root token. The operator MUST rotate this away from the bootstrap value once the stack is healthy; see the rotation note below.                                                                                                                                                                                                                                                                                                       |
| `POSTGRES_PASSWORD`                 | Password for the `tanren` Postgres user.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TANREN_GITHUB_OAUTH_CLIENT_ID`     | GitHub OAuth app client id used by `services/orchestrator/src/auth/githubProvider.ts`.                                                                                                                                                                                                                                                                                                                                                      |
| `TANREN_GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app client secret. Also written to Vault by `just vault-init-prod`.                                                                                                                                                                                                                                                                                                                                                            |
| `TANREN_PUBLIC_BASE_URL`            | The absolute URL the orchestrator is reachable at; used to compute the OAuth redirect URI.                                                                                                                                                                                                                                                                                                                                                  |
| `TANREN_RUNNER_AUTHORIZED_KEY`      | SSH `authorized_keys` line (the PUBLIC key) installed on the runner. Public — safe to pass as an env value.                                                                                                                                                                                                                                                                                                                                 |
| `TANREN_RUNNER_IDENTITY_KEY_FILE`   | HOST path to the PRIVATE key file the orchestrator SSHes into runners with. Wired as the `tanren_runner_identity_key` compose secret, mounted read-only into the orchestrator + worker at `/run/secrets/tanren_runner_identity_key` (the services read it via `TANREN_RUNNER_IDENTITY_KEY_PATH`, set by compose). The key is delivered as a mounted secret FILE, never as an env value, so it never transits Docker env / `docker inspect`. |
| `TANREN_INTERNAL_TLS_CERT`          | Path mounted in the orchestrator container to the internal mTLS server certificate.                                                                                                                                                                                                                                                                                                                                                         |
| `TANREN_INTERNAL_TLS_KEY`           | Path mounted in the orchestrator container to the internal mTLS server private key.                                                                                                                                                                                                                                                                                                                                                         |
| `TANREN_INTERNAL_TLS_CA`            | Path mounted in the orchestrator container to the CA that signs trusted data-plane client certificates.                                                                                                                                                                                                                                                                                                                                     |
| `TANREN_CLAIM_ENDPOINT_URL`         | Internal mTLS base URL the worker uses for job claims and run-state writes, typically `https://orchestrator:3110`.                                                                                                                                                                                                                                                                                                                          |
| `TANREN_DATA_PLANE_TLS_CERT`        | Path mounted in the worker container to the data-plane client certificate.                                                                                                                                                                                                                                                                                                                                                                  |
| `TANREN_DATA_PLANE_TLS_KEY`         | Path mounted in the worker container to the data-plane client private key.                                                                                                                                                                                                                                                                                                                                                                  |
| `TANREN_DATA_PLANE_TLS_CA`          | Path mounted in the worker container to the CA that verifies the control-plane internal mTLS server certificate.                                                                                                                                                                                                                                                                                                                            |

The prod profile starts the standalone `worker` service and keeps remote run-state writes enabled by default. The mTLS variables above are therefore required: the worker must claim jobs and post `events`/`cost_records` through the control plane instead of writing tenant tables directly. Mount the referenced cert/key/CA files with your platform's secret or certificate mechanism before running `just up-prod`.

Optional:

| Env var                     | Default                       | What it sets                                                                                                                                                                                                             |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DASHBOARD_HOST_PORT`       | `3000`                        | Host port the dashboard publishes on. The only host-published port in the prod profile.                                                                                                                                  |
| `CLOUDFLARED_TUNNEL_TOKEN`  | _(unset)_                     | Cloudflare Tunnel token. Required **only** when running the `tunnel` profile (see below).                                                                                                                                |
| `TANREN_OIDC_ISSUER`        | _(unset)_                     | OIDC issuer URL. Registers the `oidc` provider when set together with the client id/secret (see OIDC below).                                                                                                             |
| `TANREN_OIDC_CLIENT_ID`     | _(unset)_                     | OIDC confidential-client id.                                                                                                                                                                                             |
| `TANREN_OIDC_CLIENT_SECRET` | _(unset)_                     | OIDC confidential-client secret.                                                                                                                                                                                         |
| `TANREN_OIDC_PRESET`        | _(unset)_                     | Optional turnkey claim-mapping preset. `authentik` fills Authentik's standard claim shape + scopes by default so a homelab operator only supplies issuer + client id/secret. See [oidc-authentik.md](oidc-authentik.md). |
| `TANREN_OIDC_SCOPES`        | `openid profile email groups` | Space-separated OAuth scopes requested at authorize time.                                                                                                                                                                |
| `TANREN_OIDC_SUBJECT_CLAIM` | `sub`                         | userinfo claim used as the stable subject.                                                                                                                                                                               |
| `TANREN_OIDC_LOGIN_CLAIM`   | `preferred_username`          | userinfo claim used as the login/username.                                                                                                                                                                               |
| `TANREN_OIDC_NAME_CLAIM`    | `name`                        | userinfo claim used as the display name.                                                                                                                                                                                 |
| `TANREN_OIDC_GROUPS_CLAIM`  | `groups`                      | userinfo claim carrying org/group membership (array of strings).                                                                                                                                                         |

Missing any **required** env causes `docker compose -f compose.prod.yml config` to fail with `variable is not set` referencing the specific variable. The optional OIDC and tunnel variables default to empty and never block boot.

## OIDC identity provider (Authentik) — P3-0030

OIDC is a **second, additive** identity provider alongside the P2A-0003 GitHub OAuth provider. The orchestrator registers the `oidc` provider only when **all three** of `TANREN_OIDC_ISSUER`, `TANREN_OIDC_CLIENT_ID`, and `TANREN_OIDC_CLIENT_SECRET` are set; otherwise behavior is byte-for-byte unchanged (GitHub OAuth and the dev-login escape hatch only). No DB migration is needed — `oidc` is already an enumerated provider in the `users` table.

The provider implements the standard OIDC code flow:

1. **Discovery** — fetches `<issuer>/.well-known/openid-configuration` (cached for the process lifetime) to resolve the `token_endpoint` and `userinfo_endpoint`.
2. **Authorize** — `GET /auth/login?provider=oidc` redirects to the IdP's authorization endpoint with `response_type=code`, the configured scopes, and a CSRF `state`.
3. **Code exchange** — `GET /auth/callback?provider=oidc` exchanges the code at the token endpoint (confidential client, `client_secret_post`) and reads claims from the userinfo endpoint.
4. **Claim mapping** — `sub` -> subject, `preferred_username` -> login, `email`, `name` -> display name, and the `groups` array -> org claims with kind `oidc`. Each is overridable via the `TANREN_OIDC_*_CLAIM` envs for non-default IdPs.

### Authentik setup

In Authentik, create an **OAuth2/OpenID Provider** plus an Application bound to it:

- **Client type:** Confidential. Copy the generated client id/secret into `TANREN_OIDC_CLIENT_ID` / `TANREN_OIDC_CLIENT_SECRET`.
- **Redirect URI:** `<TANREN_PUBLIC_BASE_URL>/auth/callback?provider=oidc` (exact match).
- **Scopes:** `openid`, `profile`, `email`, and the `groups` scope so the userinfo `groups` claim is emitted; Authentik maps user group membership into Tanren orgs.
- **Issuer:** set `TANREN_OIDC_ISSUER` to the provider's issuer URL (Authentik exposes discovery at `<issuer>/.well-known/openid-configuration`).

Restart the orchestrator after setting the envs; `GET /auth/providers` then lists `oidc` alongside `github_oauth`.

### Authentik turnkey preset

For a self-hosted homelab Authentik you can skip the per-claim env tuning entirely. Set `TANREN_OIDC_PRESET=authentik` and the orchestrator fills Authentik's standard claim shape (`sub` -> subject, `preferred_username` -> login, `name` -> display name, `email`, `groups` -> orgs) and the `openid profile email groups` scopes by default, so you only supply issuer + client id/secret. Every preset value stays overridable — an explicit `TANREN_OIDC_*` env always wins. With no preset, the generic provider behavior is unchanged. A full homelab walkthrough (Authentik app/provider registration, a same-network compose snippet, and a `.env` example) lives in [oidc-authentik.md](oidc-authentik.md).

## Cloudflared tunnel exposure profile — P3-0030

`compose.prod.yml` defines a `cloudflared` service gated behind the `tunnel` Docker Compose profile, so it is **off by default** and starts only when the profile is requested:

```sh
export CLOUDFLARED_TUNNEL_TOKEN=...   # from Cloudflare Zero Trust; never commit it
docker compose -f compose.prod.yml --profile tunnel up -d
```

The tunnel token is supplied via `CLOUDFLARED_TUNNEL_TOKEN` (env / secret manager only — nothing is committed). The compose var has a soft empty default so the base `docker compose config` still validates, but cloudflared exits immediately on an empty token, so the operator must set it when starting the `tunnel` profile. The named tunnel's public hostname -> origin routing (point it at the `dashboard` service on the internal docker network) is configured in the Cloudflare Zero Trust dashboard, not in compose. When the tunnel is in use you can keep the stack fully private: cloudflared dials the origin over the internal docker network, so `DASHBOARD_HOST_PORT` does not need to be published to the host.

## TLS termination — P3-0030

TLS is terminated **at Cloudflare's edge** when the tunnel profile is used: cloudflared holds an outbound-only connection to Cloudflare and serves HTTPS for the public hostname, so the origin services never need a host-bound TLS listener or an inbound port. This is the recommended posture and pairs with `TANREN_COOKIE_SECURE=1` (already set in the prod profile), which marks session/state cookies `Secure` for the HTTPS public origin.

If you instead expose the stack without the tunnel (e.g. behind your own load balancer), terminate TLS at that reverse proxy and forward to the dashboard's published host port over the trusted internal network. In either case `TANREN_PUBLIC_BASE_URL` must be the externally reachable **https://** URL so OAuth/OIDC redirect URIs and cookie scoping line up.

## Vault enterprise key-rotation policy — P3-0030

The prod profile still boots Vault in dev mode (single root token, no seal) as a phase placeholder. For a production-grade deployment, replace it with a sealed Vault and adopt an enterprise key-rotation policy:

- **Auto-unseal + key rotation:** back the seal with a cloud KMS auto-unseal and run `vault operator rekey` on a scheduled cadence to rotate the unseal/recovery key shares. Vault Enterprise's automated key rotation can re-key the barrier without an operator-driven rekey ceremony.
- **Encryption-key rotation:** run `vault operator rotate` to advance the barrier encryption key; older keyring versions stay available to decrypt existing data while new writes use the latest key.
- **Token/credential TTLs:** keep the service AppRole token TTLs short (the init script uses 1-hour TTLs, 24-hour max) so leaked tokens expire quickly; rotate the bootstrap root token immediately after init (see the rotation note below).
- **Dynamic secrets:** where supported, prefer Vault's dynamic secrets / leases over static long-lived credentials so rotation is automatic on lease expiry.

## Port exposure (prod)

Only the dashboard publishes a host port. Postgres, Vault, the orchestrator HTTP port, the allocator sidecar, per-run runner SSH, and ntfy are reachable only on the internal docker network. The orchestrator's outward-facing surface is intentionally the dashboard. P3-0030 adds the optional cloudflared `tunnel` profile (see below) so the public surface can be served through Cloudflare's edge with no host-published port at all.

## Allocator sidecar (P2A-0010)

The Docker socket is mounted only into the `allocator` service. The orchestrator container no longer has any Docker access; it calls the allocator over HTTP on the internal docker network. Per-run runner containers are created and destroyed by the allocator; workspaces and `CODEX_HOME` are wiped on every release (success, failure, or a sweeper reclaim of a stuck/abandoned runner — abandonment is sign-of-life based, not a wall-clock TTL). See `docs/operator-guide/runners.md`.

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

## Secret-store backend selection

A secret-store backend must be selected explicitly with `TANREN_SECRET_STORE`; the
shipped Compose profiles set it to `vault`. Supported backends are `vault`,
`gcp_sm` (GCP Secret Manager), `aws_sm` (AWS Secrets Manager), `onepassword`
(1Password), and `memory` (tests).
A SaaS / cloud-native deployment can point Tanren at a managed secret manager
instead of running Vault; credential refs and tenant namespacing
(`credential/<slug>/<scope>/<ownerId>/<name>`) are uniform across backends. See
[`credentials.md`](credentials.md).

## Managed-provider toggle

For multi-tenant / SaaS-priming deployments, the orchestrator carries a
**BYOK-vs-managed provider toggle** (`engine/config/managedProvider.ts`,
`providerMode: "byok" | "managed"`, default `byok`). It defaults to BYOK /
pass-through, so a single-tenant self-hosted deployment is unaffected unless it
opts in. Tenancy is DB-enforced (mandatory `org_id`).

There is **no** admission/quota gate: `engine/quota/` was deleted and the single
project/org **budget** ceiling (walker-enforced; `GET/PUT /projects/:id/budget`
and `/orgs/:orgId/budget`) is the only spend gate. Usage metering is exported via
`engine/metering/` (`getOrgUsage` / `streamBillableRuns`).

## Principled config bucketing

This deploy doc covers the secrets and host-port surface only. The broader principled config bucketing — which fields live in DB project/org config vs. `tanren-config` repo vs. compose env — is owned by P2A-0006 (`docs/operator-guide/project-config.md`) when that spec lands.

## What is not in this spec

- A sealed (non-dev-mode) Vault. The prod profile still starts Vault in dev mode but with no static token; the enterprise key-rotation policy above documents the target posture, but wiring a sealed/auto-unseal Vault into the compose profile remains a follow-up hardening task.
- Per-org GitHub OAuth client id/secret overrides. P2A-0003 names the path shape; this spec only writes the `default` org value.
- Per-org OIDC client overrides. P3-0030 wires a single platform-wide OIDC provider via env; per-org OIDC clients are a later spec.
