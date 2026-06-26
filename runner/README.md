# Tanren Runner

This runner image provides the SSH daemon boundary for workload execution.

Codex CLI is installed as the first real Writer CLI:

- `@openai/codex@0.133.0`
- tarball verified before P1-0003: `https://registry.npmjs.org/@openai/codex/-/codex-0.133.0.tgz`

The local compose runner grants `SYS_ADMIN` with unconfined seccomp/AppArmor so
Codex `--sandbox workspace-write` can create its bubblewrap namespace inside
Docker. This is a local development runner setting; production allocators must
declare equivalent sandbox support explicitly instead of silently disabling the
Writer sandbox.

## Ephemeral per-run lifecycle (P2A-0010)

The image is consumed by the allocator sidecar (`services/allocator/`) which
creates a fresh container per `runId` and destroys it on release:

- `/workspace` is mounted from a per-run named volume; the entrypoint refuses
  to start if it contains residual files (proves the allocator's finalizer
  wiped the previous release).
- `/tanren-runtime/codex-home` is mounted from a per-run named volume that
  holds `CODEX_HOME`. The allocator decodes the supplied vault refs into a
  bundle file the runner reads from there.
- SSH host keys are regenerated on every container start; a re-used image
  never carries keys across runs and the allocator returns the freshly
  generated fingerprint to the orchestrator.

Workspaces and `CODEX_HOME` are scratch — they MUST NOT be preserved across
releases. The runner image enforces the empty-on-start invariant; the
allocator removes the underlying volumes on every release path (success or
failure).

Claude, opencode, `ccusage`, and `codexbar` remain deferred.

## Golden image — warm mise baseline + trim policy (P2)

This image IS the **golden base** (environment-management.md §3 Layer 3 + §7 P2):
the neutral sandbox + Tanren's harness + `mise` + a **warm mise cache of the
empirically-common baseline**, so a typical project's `mise install` at
workspace-prep is a warm **cache hit** (instant), not a cold download.

### What is baked vs delta'd

- **Baked (the warm baseline) — `runner/mise.baseline.toml`:** the lean,
  slow-to-install AND common toolchains, pre-warmed into the **shared** mise data
  dir `/opt/tanren/mise` at build time: **node 24** (current LTS), **pnpm 11**,
  **python 3.14** (current stable), **go 1.26** (current stable), **ruby 3.4**
  (current stable). Versions are **loose majors** so each refresh resolves the
  latest patch — never a stale pin.
- **Delta'd (cold-installed at prep):** anything OFF the baseline (node 20, python
  3.11, rust, bun, …) `mise install`s into the **same** `tanren`-owned data dir in
  user space — no failure, just not warm. This is the §3 Layer 3 baseline-vs-delta
  layering.

### Stack-agnostic OS build-deps (apex v58 #65)

The neutral sandbox base bundles the **superset of common C-level build-deps** every
toolchain's source-compile needs (bison, flex, libicu-dev, libssl-dev,
libreadline-dev, zlib1g-dev, libffi-dev, libyaml-dev, libsqlite3-dev, libbz2-dev,
liblzma-dev, libpq-dev, libxml2-dev, libxslt1-dev, libgdbm-dev, libncurses-dev,
uuid-dev, tcl-dev, autoconf, pkg-config). The non-root `tanren` user cannot
`apt install` at runtime, so any missing OS dep dead-ends a writer that picked a
source-compiled toolchain (apex v58: vfox-postgres failed on `bison not found` and
the writer iterated 78× without ever passing bootstrap). Bundling the superset
keeps the runner **stack-agnostic by construction** — a writer's stack choice is
never blocked on missing OS packages. Adding to that list is a doctrine call: a new
**C-level** dep that a **common** toolchain's source-compile depends on belongs in
the bundle; a project-specific library does not (the project provisions it inside
its own container/dev-shell).

### Trim discipline (GitHub `runner-images` rule)

**Bake what's slow-to-install AND common; omit the rare.** The baseline is
deliberately five toolchains — NOT "everything". Adding a tool to the baseline is a
trade: image size + refresh time vs. how often a project actually declares it. The
bar to bake: slow to install **and** declared by a meaningful share of projects.

### Harness/baseline isolation

`mise` is installed as a binary only and is **never globally activated**, so the
shared warm baseline never shadows the **harness** node (`/usr/local`, node 24): a
bare SSH shell + `codex`/`codexbar`/`ccusage` resolve the harness node regardless of
what the warm baseline (or a project's `mise.toml`) declares. A project's toolchain
is active only within a command that opts in (`eval "$(mise activate bash)"`, via
`engine/ssh/miseActivate.ts`). The shared `/opt/tanren/mise` dir is `tanren`-owned
(warm + writable for the delta) yet world-readable (a warm hit is a pure read).

### Build + registry

- `just build-golden-image` (→ `scripts/dev/build-golden-image.sh`): BuildKit build,
  content-digest tag (`golden-<digest>`), registry `mode=max` cache. Local by
  default; `PUSH=1 REGISTRY=localhost:5000` pushes to the dev registry.
- `compose.dev.yml` ships a local `registry:2` (host `:5000`) — the self-hosted OCI
  backend that makes the later phases (P3 env_key resolution, P4 JIT creation)
  locally validatable with no cloud.
- `.github/workflows/golden-image.yml` re-bakes + pushes on every `main` change to
  `runner/**` (refresh-on-`main`), applying the same cache.
