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
