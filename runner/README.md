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

Claude, opencode, `ccusage`, and `codexbar` remain deferred.
