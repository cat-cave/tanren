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

| Method | Path        | Body                                                                      | Response                                                                                      |
| ------ | ----------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/allocate` | `{ runId, projectId, runnerImage, orgId, runless?, persistedProjectId? }` | `{ runnerId, sshHost, sshPort, hostKeyFingerprint, imageSha }` (HTTP 201)                     |
| POST   | `/release`  | `{ runnerId, reason: "completed" \| "failed" \| "abandoned" }`            | `{ released: boolean }`                                                                       |
| GET    | `/healthz`  | _none_                                                                    | `{ service: "allocator", ok }` — `ok` flips to `false` when the docker socket is unreachable. |

The allocator runs on `ALLOCATOR_PORT` (default `3200`). `runnerImage` is supplied
**per allocation** in the request body (the orchestrator threads the project's
configured runner image) — it is _not_ an allocator env knob. `orgId` is required:
the allocator writes the `runners` row under that org's RLS scope. The runner's
model/codex credentials are **not** part of this request — they are delivered over
the SSH file substrate _after_ allocation, so the allocator never resolves a secret
value (there is no `vaultRefs` and no CODEX_HOME env bundle). `runless` marks a
Forge ideation allocation whose persisted `run_id` is NULL.

`/release` is idempotent: releasing an already-released runner returns
`{ released: false }`.

## Per-run lifecycle

On `/allocate` the allocator:

1. Resolves the public `TANREN_RUNNER_AUTHORIZED_KEY` (fail-closed: a blank/unset
   key throws before any side effect, so a misconfigured allocator never spends a
   container on a runner the orchestrator could never SSH into).
2. Creates per-run named volumes for `/workspace` and `/tanren-runtime/codex-home`.
3. Creates a fresh container with the per-run volumes mounted and only the public
   authorized-key line + the ephemeral marker in its env (no secret value is ever
   delivered via Docker env), attaches it to the internal docker network, and
   starts it.
4. Polls for the regenerated SSH host key inside the container until it appears
   (a sign-of-life probe, _not_ an attempt-capped timeout — see below), hashes it,
   and returns the fingerprint to the orchestrator.
5. Writes a durable `allocator.allocated` audit event under the run's org scope.

Run-scoped runner credentials (the tenant's model / codex auth) are written into
CODEX*HOME over the **SSH file substrate** \_after* allocation by the orchestrator's
materializer — so `docker inspect` on a runner can carry no secret. The runner
image regenerates `/etc/ssh/ssh_host_*` keys on every container start (see
`runner/entrypoint.sh`); the image never carries keys across runs.

The host-key readiness poll has **no attempt ceiling**: a slow-booting container
is never given up on by a counter. The only give-up condition is genuine failure —
the container observed no longer running (sshd boot crashed), which fails loud.

On `/release` the allocator:

1. Stops the container (best-effort; the finalizer continues even if the
   container has already exited).
2. Removes the container.
3. Removes the workspace and CODEX_HOME volumes.
4. Marks the runner row in `runners` as released / failed / abandoned.

Nothing from a previous run survives a release on either the success or
failure path. The runner image's entrypoint asserts this invariant on
container start (refuses to start if `/workspace` is non-empty).

## Abandoned-runner sweeper (sign-of-life, not wall-clock)

The allocator runs a background sweeper (interval `TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS`,
default 60s) that reconciles **stuck/leaked** runners the normal `/release` path
missed. It is **not** an age-based reaper: a long-but-_alive_ run is never reaped,
no matter how many hours it has been running — "10 minutes, or 6 hours, is nothing
to an AI agent on a big build". There is no `TANREN_MAX_RUN_HOURS` age cap on a
live runner anymore. A runner is reclaimed only when there is genuinely **no sign
of life**, in one of three discriminated states (`RunnerReclaimReason`):

| Reason            | What it detects                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terminal_run`    | The owning run is terminal (completed/failed/halted/cancelled) yet the runner was never released — the run crashed before its release `finally`.                                     |
| `lease_lapsed`    | The owning run's worker stopped renewing its `job_queue` lease (a `running` job whose `leased_until` is in the past, with no other live job) — the **driver is dead**.               |
| `unclaimed_grace` | A wedged allocation never tied to a live `runs` row (`run_id IS NULL`), older than `TANREN_ALLOCATOR_UNCLAIMED_GRACE_MS` (default 15min — absorbs the allocate→first-lease handoff). |

Each reclaim goes through the same single-atomic-claim `/release` finalizer (so a
healthy in-flight runner is never touched and a concurrent `/release` race tears
down exactly once), wipes the workspace + CODEX_HOME volumes, and writes a durable
`runner.swept` audit event tagged with the reason. An audit-write failure is logged
and counted, never swallowed.

## Dev vs prod profile

| Concern                   | `compose.dev.yml`                                                                                    | `compose.prod.yml`                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Allocator host port       | `3200` exposed for opt-in host-side live tests                                                       | not exposed                                                   |
| Static `runner` service   | Yes, on host port `2222` (host-side direct SSH proof for `just smoke-connectivity` / the live tests) | Removed entirely; runners are ephemeral and have no host port |
| Per-run runners published | No (internal-only; orchestrator reaches them via docker DNS)                                         | No (internal-only)                                            |
| Allocator bearer token    | Hard-coded `dev`                                                                                     | Mounted secret file (`TANREN_ALLOCATOR_TOKEN_FILE`)           |

In dev, opt-in live tests that run on the host (`just live-phase1-fixture`,
`just smoke-ssh-integration`, etc.) continue to target the static `runner`
service on `localhost:2222`. Workflow runs initiated through the orchestrator
go through the sidecar and use ephemeral runners on the internal network.

## Required env

**Allocator service env** (read by `services/allocator/src/envSchema.ts`):

| Env var                                  | Default                                  | Required in prod | Notes                                                                                                             |
| ---------------------------------------- | ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_TOKEN`                 | `"dev"`                                  | Yes              | Bearer token gating `/allocate` + `/release`. In prod delivered as a mounted secret file (`*_TOKEN_FILE`).        |
| `TANREN_RUNNER_AUTHORIZED_KEY`           | _(unset)_                                | Yes              | Public SSH authorized-key line baked into each runner; allocation fails closed if blank.                          |
| `ALLOCATOR_PORT`                         | `3200`                                   | No               | Allocator HTTP port.                                                                                              |
| `TANREN_ALLOCATOR_NETWORK`               | `tanren_default`                         | No               | Docker network name the per-run containers attach to.                                                             |
| `TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE` | `{container}`                            | No               | Template for the orchestrator-facing SSH hostname.                                                                |
| `TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS`   | `60000`                                  | No               | How often the abandoned-runner sweeper polls.                                                                     |
| `TANREN_ALLOCATOR_UNCLAIMED_GRACE_MS`    | `900000` (15min)                         | No               | Grace window before a never-claimed (run-less) allocation is reclaimed as wedged. _Not_ an age cap on a live run. |
| `TANREN_RUNNER_CAP_ADD`                  | `SYS_ADMIN`                              | No               | Linux capabilities the runner container is launched with (comma-separated).                                       |
| `TANREN_RUNNER_SECURITY_OPT`             | `apparmor=unconfined,seccomp=unconfined` | No               | security-opt the runner container is launched with.                                                               |

There is **no** `TANREN_MAX_RUN_HOURS` allocator knob — the sweeper reaps on
sign-of-life, not age. (`TANREN_MAX_RUN_HOURS` still exists, but only as the
_orchestrator's_ scoped-credential token TTL ceiling, resolved in
`plannerRunScopedCreds`; it does not bound runner lifetime.)

**Orchestrator-side allocator client env** (read by `services/orchestrator`):

| Env var                 | Default                 | Notes                                                                         |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_URL`  | `http://allocator:3200` | Allocator base URL the orchestrator calls.                                    |
| `TANREN_ALLOCATOR_KIND` | `sidecar`               | Which allocator backend to build (see below); `router` enables label routing. |

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

For a single backend, set `TANREN_ALLOCATOR_KIND` to any implemented kind —
`static`, `sidecar`, `manual_ssh`, `hetzner`, `digitalocean`, `gcp`, `aws_ec2`,
or `kubernetes` (default `sidecar`). Behavior is unchanged for the two
pre-existing kinds (`static`, `sidecar`).

### Env for the new allocators

| Env var                                       | Used by      | Notes                                                                                           |
| --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `TANREN_ALLOCATOR_KIND=router`                | router       | Enables label routing + pool policy                                                             |
| `TANREN_ALLOCATOR_ROUTING`                    | router       | JSON routing config (see above)                                                                 |
| `TANREN_MANUAL_SSH_HOSTS`                     | `manual_ssh` | JSON array `[{ id, host, port?, username?, hostKeyFingerprint, identitySecretRef? }]`           |
| `TANREN_HETZNER_API_TOKEN`                    | `hetzner`    | Project API token (the org grant). Sourced from a Vault ref by operator tooling; never hardcode |
| `TANREN_HETZNER_SERVER_TYPE`                  | `hetzner`    | e.g. `cx22` (default)                                                                           |
| `TANREN_HETZNER_IMAGE`                        | `hetzner`    | e.g. `docker-ce` (default)                                                                      |
| `TANREN_HETZNER_LOCATION`                     | `hetzner`    | e.g. `nbg1`                                                                                     |
| `TANREN_HETZNER_EXTRA_CLOUD_INIT_WRITE_FILES` | `hetzner`    | Optional extra cloud-init `write_files:` entries merged with the host-key injection             |
| `TANREN_HETZNER_SSH_USER`                     | `hetzner`    | SSH username (default `root`)                                                                   |

> **SSH is fully Tanren-managed (P-INT-5).** The Hetzner allocator no longer
> takes a manual `TANREN_HETZNER_SSH_KEYS` or `TANREN_HETZNER_HOST_FINGERPRINT`.
> Per allocation it generates an **ephemeral ed25519 client keypair**, uploads
> the public key to Hetzner (`POST /v1/ssh_keys`), references it in the
> server-create, and stores the **private** key in the secret manager (never
> logged / never in config); the runner SSH identity materializes from that ref.
> It also generates an **ephemeral host keypair**, injects the host private key
> via cloud-init so the server presents a **known** host key on first connect,
> and pins that key's locally-computed SHA256 fingerprint — deterministic, no
> pre-known fingerprint, no TOFU. Release destroys the server, deletes the
> Hetzner ssh_key, and wipes the stored private key.

The DigitalOcean, GCP, and AWS EC2 allocators take an analogous set of env vars —
`TANREN_DO_*` (API token, region, size, image, host fingerprint),
`TANREN_GCP_*` (project, zone, machine type, image, access token, host
fingerprint), and `TANREN_AWS_*` (region, access key id/secret, instance type,
AMI id, host fingerprint) — while Kubernetes uses the `TANREN_K8S_*` vars listed
earlier. All cloud allocators take credentials via config/Vault refs only and go
through an injectable HTTP client, unit-tested against mocked APIs with no live
credentials.

## What is not in this guide

- **Live cloud validation.** The DigitalOcean / GCP / AWS EC2 / Kubernetes
  allocators are fully **implemented** (see the table above — the scaffold stubs
  are gone) and unit-tested against mocked cloud APIs, but provisioning against
  real cloud accounts has not been live-validated (needs cloud credentials).
- The allocator-side workflow / job queue split (the orchestrator-side mirror in
  `runners` is best-effort consistent) remains a hardening follow-up.
- Per-org runner image overrides remain a later addition.
