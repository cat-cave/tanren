# Runners and the allocator sidecar

P2A-0010 introduces the **allocator** service: a narrow sidecar that owns the
Docker socket and creates ephemeral per-run runner containers on behalf of the
orchestrator. The orchestrator container no longer has Docker socket access in
either compose profile.

## Topology

```
orchestrator (no docker socket)
    │ HTTP (internal docker network)
    ▼
allocator (owns docker socket)
    │ docker create / start / exec / kill / rm
    ▼
per-run runner container (ephemeral)
    ▲
    │ SSH (orchestrator → runner over the internal docker network)
    │
orchestrator
```

## Internal API

The allocator exposes three HTTP endpoints. Only the orchestrator container
reaches them (internal docker network). The endpoints are authenticated with
the shared bearer token `TANREN_ALLOCATOR_TOKEN`.

| Method | Path        | Body                                                           | Response                                                                                      |
| ------ | ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/allocate` | `{ runId, projectId, runnerImage, vaultRefs: string[] }`       | `{ runnerId, sshHost, sshPort, hostKeyFingerprint, imageSha }`                                |
| POST   | `/release`  | `{ runnerId, reason: "completed" \| "failed" \| "abandoned" }` | `{ released: boolean }`                                                                       |
| GET    | `/healthz`  | _none_                                                         | `{ service: "allocator", ok }` — `ok` flips to `false` when the docker socket is unreachable. |

`/release` is idempotent: releasing an already-released runner returns
`{ released: false }`.

## Per-run lifecycle

On `/allocate` the allocator:

1. Creates per-run named volumes for `/workspace` and `/tanren-runtime/codex-home`.
2. Materializes the supplied vault refs into a base64 bundle the runner reads
   from `TANREN_CODEX_HOME_BUNDLE`.
3. Creates a fresh container with the per-run volumes mounted, attaches it to
   the internal docker network, and starts it.
4. Polls for the regenerated SSH host key inside the container, hashes it, and
   returns the fingerprint to the orchestrator.

The runner image regenerates `/etc/ssh/ssh_host_*` keys on every container
start (see `runner/entrypoint.sh`); the image never carries keys across runs.

On `/release` the allocator:

1. Stops the container (best-effort; the finalizer continues even if the
   container has already exited).
2. Removes the container.
3. Removes the workspace and CODEX_HOME volumes.
4. Marks the runner row in `runners` as released / failed / abandoned.

Nothing from a previous run survives a release on either the success or
failure path. The runner image's entrypoint asserts this invariant on
container start (refuses to start if `/workspace` is non-empty).

## TTL sweeper

The allocator runs a background sweeper that polls the `runners` table for
rows still `claimed` past `TANREN_MAX_RUN_HOURS` (default 6) and releases them
with `reason: "abandoned"`. This handles the case where the orchestrator
crashes mid-run and never calls `/release`. The sweeper goes through the same
finalizer path as `/release`, so the workspace and CODEX_HOME volumes are
still wiped.

## Dev vs prod profile

| Concern                   | `compose.dev.yml`                                                              | `compose.prod.yml`                                            |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Allocator host port       | `3200` exposed for opt-in host-side live tests                                 | not exposed                                                   |
| Static `runner` service   | Yes, on host port `2222` (backward-compat for `just smoke`'s direct SSH proof) | Removed entirely; runners are ephemeral and have no host port |
| Per-run runners published | No (internal-only; orchestrator reaches them via docker DNS)                   | No (internal-only)                                            |
| Allocator bearer token    | Hard-coded `dev`                                                               | Required via `TANREN_ALLOCATOR_TOKEN` env                     |

In dev, opt-in live tests that run on the host (`just live-phase1-fixture`,
`just smoke-ssh-integration`, etc.) continue to target the static `runner`
service on `localhost:2222`. Workflow runs initiated through the orchestrator
go through the sidecar and use ephemeral runners on the internal network.

## Required env

| Env var                                | Default                             | Required in prod | Notes                                                                 |
| -------------------------------------- | ----------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_TOKEN`               | `"dev"`                             | Yes              | Shared bearer token between orchestrator and allocator                |
| `TANREN_MAX_RUN_HOURS`                 | `6`                                 | No               | Max wall-clock hours before the sweeper reclaims an active runner row |
| `TANREN_RUNNER_IMAGE`                  | `ghcr.io/cat-cave/tanren-runner:v0` | No               | Image the allocator pulls / uses for per-run runner containers        |
| `TANREN_ALLOCATOR_URL`                 | `http://allocator:3200`             | No               | Orchestrator-side allocator base URL                                  |
| `TANREN_ALLOCATOR_NETWORK`             | derived                             | No               | Docker network name the per-run containers attach to                  |
| `TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS` | `60000`                             | No               | How often the sweeper polls                                           |

## Architecture-check invariants

`scripts/check-architecture.mjs` enforces:

- `/var/run/docker.sock` mounts are allowed only on the `allocator` compose
  service. (Previously this was allowed on the orchestrator; that allowance
  has been removed.)
- Docker API patterns (`/var/run/docker.sock`, `/containers/.../json`,
  `socketPath:`) appear only in `services/allocator/**` and the orchestrator's
  allocator client surface.

## Remote allocators, routing, and pool policy (P3-0027)

P3-0027 adds remote allocators behind the same `Allocator` interface
(`allocate(request) → RunnerAllocation`, `release(runnerId, reason)`), plus a
**router** that picks an allocator by run labels and enforces per-kind **pool
policy**. All of this lives in `services/orchestrator/src/engine/allocators/**`;
no schema migration was required — routing/pool policy is plain config (env JSON
today, and can live in the existing `projects.config` JSONB later).

### Allocator kinds

| Kind           | Status      | What it does                                                                   |
| -------------- | ----------- | ------------------------------------------------------------------------------ |
| `static`       | implemented | Dev compose static runner (TOFU host key). Existing behavior.                  |
| `sidecar`      | implemented | Ephemeral per-run container via the allocator sidecar. Existing behavior.      |
| `manual_ssh`   | implemented | Leases a pre-provisioned SSH host from a configured pool. No cloud API.        |
| `hetzner`      | implemented | Provisions a Hetzner Cloud server on demand; destroys it on release.           |
| `digitalocean` | implemented | Provisions a DigitalOcean droplet on demand; destroys it on release.           |
| `gcp`          | implemented | Provisions a GCE instance on demand; deletes it on release.                    |
| `aws_ec2`      | implemented | Runs an EC2 instance on demand; terminates it on release.                      |
| `kubernetes`   | implemented | Schedules a runner Pod on demand; deletes the Pod + SSH-key Secret on release. |

Every kind now has a real implementation. An unrouted real kind that is never
selected resolves to a stub that throws a clear "not configured" error if it is
ever selected, so a misconfigured deployment fails fast rather than silently
provisioning.

The `kubernetes` allocator schedules a single-tenant runner **Pod** (runner
image, `restartPolicy: Never`) in `TANREN_K8S_NAMESPACE`, delivering the runner
SSH public key via a per-run Opaque **Secret** referenced as a container env var
(no key material in the Pod spec or image). It polls the Pod until `phase:
Running` with a non-empty `podIP`, then returns that **Pod IP** on port 22 as the
SSH target. This assumes the orchestrator can reach Pod IPs directly (running
in-cluster, or via a flat pod network / VPN); no Service or NodePort is created.
Like the other cloud allocators it pins a pre-known host-key fingerprint
(`TANREN_K8S_HOST_FINGERPRINT`, baked into the runner image) rather than doing
TOFU. Required env: `TANREN_K8S_API_SERVER`, `TANREN_K8S_TOKEN_REF`,
`TANREN_K8S_NAMESPACE`, `TANREN_K8S_RUNNER_IMAGE`, `TANREN_K8S_SSH_PUBLIC_KEY`,
`TANREN_K8S_HOST_FINGERPRINT` (optional: `TANREN_K8S_SSH_USER`,
`TANREN_K8S_CA_PEM`).

### Label routing + pool policy

Set `TANREN_ALLOCATOR_KIND=router` and supply `TANREN_ALLOCATOR_ROUTING` as a
JSON document:

```jsonc
{
  "defaultAllocator": "sidecar",
  "rules": [
    { "matchLabels": { "tier": "gpu" }, "allocator": "hetzner" },
    { "matchLabels": { "env": "staging" }, "allocator": "manual_ssh" },
  ],
  "pools": {
    "hetzner": { "maxConcurrent": 5, "reuse": false },
    "manual_ssh": { "maxConcurrent": 3, "reuse": true },
  },
}
```

- **Routing**: a run's labels are matched against `rules` in order; the first
  rule whose `matchLabels` are _all_ present (exact value match) wins. If no
  rule matches, `defaultAllocator` is used.
- **Pool policy**: `maxConcurrent` caps in-flight runners per kind — the router
  rejects an `allocate` past the cap with `PoolCapacityExceededError` (release
  frees a slot). `reuse` records whether targets are long-lived (manual-ssh
  reuses hosts) or ephemeral (hetzner destroys on release).

Only the kinds the routing config can actually select are constructed with real
credentials; an unrouted real kind resolves to a stub that throws if selected,
so a misconfigured token never silently provisions.

### Single-kind selection (no router)

For a single backend, keep `TANREN_ALLOCATOR_KIND` set to `static`, `sidecar`,
`manual_ssh`, or `hetzner` (default `sidecar`). Behavior is unchanged for the
two pre-existing kinds.

### Env for the new allocators

| Env var                           | Used by      | Notes                                                                                 |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_KIND=router`    | router       | Enables label routing + pool policy                                                   |
| `TANREN_ALLOCATOR_ROUTING`        | router       | JSON routing config (see above)                                                       |
| `TANREN_MANUAL_SSH_HOSTS`         | `manual_ssh` | JSON array `[{ id, host, port?, username?, hostKeyFingerprint, identitySecretRef? }]` |
| `TANREN_HETZNER_API_TOKEN`        | `hetzner`    | API token. Sourced from a Vault ref by operator tooling; never hardcode               |
| `TANREN_HETZNER_HOST_FINGERPRINT` | `hetzner`    | Pinned SHA256 host key fingerprint (baked into the image / cloud-init)                |
| `TANREN_HETZNER_SERVER_TYPE`      | `hetzner`    | e.g. `cx22` (default)                                                                 |
| `TANREN_HETZNER_IMAGE`            | `hetzner`    | e.g. `docker-ce` (default)                                                            |
| `TANREN_HETZNER_LOCATION`         | `hetzner`    | e.g. `nbg1`                                                                           |
| `TANREN_HETZNER_SSH_KEYS`         | `hetzner`    | Comma-separated Hetzner SSH key ids/names to authorize                                |
| `TANREN_HETZNER_SSH_USER`         | `hetzner`    | SSH username (default `root`)                                                         |

Cloud allocators take credentials via config/Vault refs only; the Hetzner API
calls go through an injectable HTTP client and are unit-tested against a mocked
API with no live credentials.

## What is not in this spec

- The DigitalOcean / AWS EC2 / Kubernetes allocators are scaffolded stubs; their
  provisioning logic is a P3-0027 follow-up.
- The allocator-side workflow / job queue split (currently the
  orchestrator-side mirror in `runners` is best-effort consistent) lands when
  the post-Phase-2A operator workflow story does.
- Per-org runner image overrides are a later P2A spec.
