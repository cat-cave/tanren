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

| Method | Path        | Body                                                                                 | Response                                                                                       |
| ------ | ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| POST   | `/allocate` | `{ runId, projectId, runnerImage, vaultRefs: string[] }`                             | `{ runnerId, sshHost, sshPort, hostKeyFingerprint, imageSha }`                                 |
| POST   | `/release`  | `{ runnerId, reason: "completed" \| "failed" \| "abandoned" }`                       | `{ released: boolean }`                                                                        |
| GET    | `/healthz`  | _none_                                                                               | `{ service: "allocator", ok }` — `ok` flips to `false` when the docker socket is unreachable. |

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

| Concern                          | `compose.dev.yml`                                                                | `compose.prod.yml`                                                |
| -------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Allocator host port              | `3200` exposed for opt-in host-side live tests                                   | not exposed                                                       |
| Static `runner` service          | Yes, on host port `2222` (backward-compat for `just smoke`'s direct SSH proof) | Removed entirely; runners are ephemeral and have no host port    |
| Per-run runners published        | No (internal-only; orchestrator reaches them via docker DNS)                     | No (internal-only)                                                |
| Allocator bearer token           | Hard-coded `dev`                                                                 | Required via `TANREN_ALLOCATOR_TOKEN` env                         |

In dev, opt-in live tests that run on the host (`just live-phase1-fixture`,
`just smoke-ssh-integration`, etc.) continue to target the static `runner`
service on `localhost:2222`. Workflow runs initiated through the orchestrator
go through the sidecar and use ephemeral runners on the internal network.

## Required env

| Env var                             | Default       | Required in prod | Notes                                                                  |
| ----------------------------------- | ------------- | ---------------- | ---------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_TOKEN`            | `"dev"`       | Yes              | Shared bearer token between orchestrator and allocator                  |
| `TANREN_MAX_RUN_HOURS`              | `6`           | No               | Max wall-clock hours before the sweeper reclaims an active runner row   |
| `TANREN_RUNNER_IMAGE`               | `ghcr.io/cat-cave/tanren-runner:v0` | No | Image the allocator pulls / uses for per-run runner containers |
| `TANREN_ALLOCATOR_URL`              | `http://allocator:3200` | No   | Orchestrator-side allocator base URL                                    |
| `TANREN_ALLOCATOR_NETWORK`          | derived       | No               | Docker network name the per-run containers attach to                    |
| `TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS` | `60000`    | No               | How often the sweeper polls                                             |

## Architecture-check invariants

`scripts/check-architecture.mjs` enforces:

- `/var/run/docker.sock` mounts are allowed only on the `allocator` compose
  service. (Previously this was allowed on the orchestrator; that allowance
  has been removed.)
- Docker API patterns (`/var/run/docker.sock`, `/containers/.../json`,
  `socketPath:`) appear only in `services/allocator/**` and the orchestrator's
  allocator client surface.

## What is not in this spec

- Remote allocators (Hetzner, AWS, k8s) are Phase 3+.
- The allocator-side workflow / job queue split (currently the
  orchestrator-side mirror in `runners` is best-effort consistent) lands when
  the post-Phase-2A operator workflow story does.
- Per-org runner image overrides are a later P2A spec.
