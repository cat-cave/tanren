# Architecture Checks Contract

`scripts/check-architecture.mjs` enforces project-specific rules that span TypeScript, SQL, YAML, Dockerfiles, shell, and docs. Use oxlint for standard TypeScript linting; keep Tanren-specific invariants here.

## Checks

- `file-line-max-500`: source, config, and docs files must stay at or below 500 lines. Exclusions are `PROJECT_BRIEF.md`, `pnpm-lock.yaml`, generated output, dependencies, and documented future migration exceptions.
- `no-host-process-spawn`: `node:child_process` and `child_process` imports are allowed only in `services/orchestrator/src/engine/cli-runner/**`.
- `no-docker-exec-for-workloads`: `container.exec(` and shell `docker exec` workload patterns are allowed only in allocator lifecycle code.
- `no-host-bind-mounts`: Compose and Docker API host bind mounts are blocked. Named volumes are allowed. A future Docker socket mount for the local allocator must be documented here before it is introduced.
- `single-event-writer`: SQL writes to `events` and Drizzle-style event inserts are allowed only in `services/orchestrator/src/engine/eventStore.ts` and database migrations.
- `forbidden-failure-variants`: `Failure.kind` may not define host-prefixed variants. The guard helper may mention the prefix only to reject it.
- `writer-answerer-separation`: non-dispatcher source files may not call or import both writer and answerer execution paths. Current dispatchers are `helloWorkflow.ts` and future files under `services/orchestrator/src/engine/dispatchers/**`.
- `no-unknown-cost-source`: `legacy_unknown` is forbidden and SQL cost-source checks must stay within `provider_direct`, `ccusage`, `codexbar`, and `opportunity_computed`.
- `github-actions-current-major`: CI must keep `actions/checkout@v6` and `actions/setup-node@v6`; older majors are blocked.
- `required-docs-present`: `AGENTS.md`, core playbooks, and this contract must exist.

## Exception Path

Prefer refactoring over exceptions. A new exception requires a short entry in this file naming the rule, file path, why the invariant still holds, and the deletion condition. The checker should point at that exact allowlist.

No active exceptions are approved.
