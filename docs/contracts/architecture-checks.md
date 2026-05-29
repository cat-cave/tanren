# Architecture Checks Contract

`scripts/check-architecture.mjs` enforces project-specific rules that span TypeScript, SQL, YAML, Dockerfiles, shell, and docs. Use oxlint for standard TypeScript linting; keep Tanren-specific invariants here.

## Checks

- `file-line-max-500`: source, config, and docs files must stay at or below 500 lines. Exclusions are `PROJECT_BRIEF.md`, `pnpm-lock.yaml`, generated output, dependencies, and documented migration metadata exceptions.
- `no-host-process-spawn`: `node:child_process` and `child_process` imports are allowed only in `services/orchestrator/src/engine/cli-runner/**`.
- `no-docker-exec-for-workloads`: `container.exec(` and shell `docker exec` workload patterns are allowed only in allocator lifecycle code.
- `no-host-bind-mounts`: Compose and Docker API host bind mounts are blocked. Named volumes are allowed. The only host bind exception is the orchestrator Docker socket mount documented below.
- `docker-api-allocator-only`: Docker socket and Docker Engine container API access are confined to `services/orchestrator/src/engine/allocators/**`. The Docker socket mount in `compose.dev.yml` and `compose.prod.yml` exists only so `LocalDockerAllocator` can claim and inspect the shared local runner.
- `single-event-writer`: SQL writes to `events` and Drizzle-style event inserts are allowed only in `services/orchestrator/src/engine/eventStore.ts` and database migrations.
- `forbidden-failure-variants`: `Failure.kind` may not define host-prefixed variants. The guard helper may mention the prefix only to reject it.
- `writer-answerer-separation`: non-dispatcher source files may not call or import both writer and answerer execution paths. Current dispatchers are files under `services/orchestrator/src/engine/workflow/**` and future files under `services/orchestrator/src/engine/dispatchers/**`.
- `no-unknown-cost-source`: `legacy_unknown` is forbidden. SQL `cost_basis` CHECK constraints must stay within `ccusage`, `provider_pricing`, and `unknown`; SQL `billing_mode` CHECK constraints must stay within `per_token`, `subscription`, and `self_hosted`. `unknown` cost basis (with `cost_usd` NULL) is an honest, allowed state — token accounting is mandatory, but cost is best-effort.
- `github-actions-current-major`: CI must keep `actions/checkout@v6` and `actions/setup-node@v6`; older majors are blocked.
- `schema-drift-check-wired`: root `package.json` must keep `check:schema-drift` wired to `scripts/check-schema-drift.sh`, and root `check` must run it.
- `answerer-schema-drift-check-wired`: root `package.json` must keep `check:answerer-schema-drift` wired to `scripts/answerer-schema-export.mjs`, and root `check` must run it (directly or via `just ci`).
- `required-docs-present`: `AGENTS.md`, core playbooks, and this contract must exist.

## Structural ratchets (Track B wave 3)

These three live in the sibling module `scripts/check-architecture-structure.mjs` (kept separate so `check-architecture.mjs` stays under the 500-line cap). They are heuristic, regex/brace-matching scanners — not a real AST — and each is a **non-regressing ratchet**: the threshold is pinned at or just above the current repo maximum so existing code passes today, and is meant to be tightened in a later wave as the flagged hotspot is refactored. Tightening a cap is the deliverable, not an exception.

- `cyclomatic-complexity-cap`: per-function heuristic complexity (1 + one per `if`/`case`/`&&`/`||`/ternary `?`/`catch`/`for`/`while`; `??`, `?.`, and `?:` are not branches) on `services/orchestrator/src/engine/workflow/**` and `services/orchestrator/src/engine/answerers/**`. **Measured current max: 23** (`runPlannerLoopWorkflow` in `engine/workflow/plannerRun.ts`). **Cap: 25.** Ratchet target: decompose `plannerRun` and lower the cap toward ~15.
- `max-params-cap`: per-function positional parameter count on the same critical directories. **Measured current max: 6** (a step helper in `engine/workflow/helloRun.ts`). **Cap: 6** (pinned at current max). New functions that would exceed it must thread an options object.
- `cross-package-deep-import`: an import may only reach another workspace package through its public entry. Bare `@tanren/<pkg>/src/**` specifiers and relative specifiers that resolve into a _different_ package's tree are flagged. **Two historical violations** (orchestrator state tests importing `../../../db/src/stateEnums.js`) were fixed in this wave by re-exporting `stateEnumLists`/`StateEnumName` from the `@tanren/db` entry and importing via `@tanren/db`; the allowlist is empty.

## Exception Path

Prefer refactoring over exceptions. A new exception requires a short entry in this file naming the rule, file path, why the invariant still holds, and the deletion condition. The checker should point at that exact allowlist.

Active exception: `db/migrations/meta/**` is Drizzle-generated migration metadata and may exceed 500 lines. Delete this exception if Drizzle supports split or compact metadata that preserves drift detection.

Active exception: `services/orchestrator/src/engine/answerers/schemas/generated/**` is the JSON Schema mirror emitted by `scripts/answerer-schema-export.mjs` from the Zod sources in the same directory. The drift test at `services/orchestrator/tests/answererSchemaDrift.test.ts` keeps the mirror honest; the file size grows with the Forge tool-call discriminated union so the human-readable diff stays the source of review value. Delete this exception if the generator ever switches to a compact format that keeps PR diffs reviewable.

Active exception: `compose.dev.yml` and `compose.prod.yml` mount `/var/run/docker.sock` into `orchestrator` for SPEC-0003 local runner lifecycle metadata. Workload execution still goes through `SshSubstrate`; allocator code may inspect/claim containers but must not run agent workloads through Docker. Delete this exception when P2A-0010 lands the dedicated allocator sidecar and local allocation no longer needs direct Docker Engine access from the orchestrator.
