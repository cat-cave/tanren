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
- `contract-schema-drift-check-wired`: root `package.json` must keep `check:contract-schema-drift` wired to `scripts/contract-schema-export.mjs`, and root `check` must run it (directly or via `just ci`). This pins the unified JSON-Schema export (Track C §3) — `contracts/json/**` — against drift from its Zod sources.
- `required-docs-present`: `AGENTS.md`, core playbooks, and this contract must exist.
- `no-production-stubs`: in any `**/src/**` non-test file, a stub / mock / deterministic-stand-in / no-op-policy identifier (`createDeterministic*Answerer`, a CamelCase-delimited `stub`/`noop`/`fake`/`mock` word — both casings, e.g. `StubChannel` and `noopConflictResolver` — and `templated*` generators) may not be **constructed** (`new …(`) or **default-assigned** (`?? …` / `|| …` / `= …(`). A bare type definition is not a construction and is not flagged. Lives in the sibling module `scripts/check-architecture-stubs.mjs` (keeps `check-architecture.mjs` under the 500-line cap). See the allowlist below.

## no-production-stubs allowlist (P8a §8a)

The stub-ban lint enforces the repo invariant that a stub/mock/no-op may exist **only** under `tests/` and may never be the value a production `src/` path constructs or defaults to. The default of an injectable seam in production must be the **real** impl, or a **hard failure** when unconfigured. A seam whose real impl exists but is unwired stays flagged until wired (the §8a ratchet).

The allowlist is finite, enumerated in `scripts/check-architecture-stubs.mjs`, and **honored only when the construction's file carries an in-source `// arch-allow: <reason>` annotation** (so the exemption is reviewable). Two kinds:

- **Absence-is-honest (permanent).** `StubChannel` in `services/orchestrator/src/engine/notifications/registry.ts`: an unconfigured notification channel resolves to a `StubChannel` that records the dispatch as `stubbed` in the notifications log — an honest "not wired" audit record, never a silent drop.
- **Phase-pending (temporary — tightens when the phase lands).** Each is the no-op default for a seam whose **real replacement is not yet built**; when the real impl is wired as the production default, delete the fallback and remove the entry:
  - `noopConflictResolver` in `services/orchestrator/src/engine/workflow/reviewMerge/mergeDispatch.ts` — replaced by the **P2b** intent-preserving conflict resolver.
  - `createNoopPassRunner` in `services/orchestrator/src/routes/audits/index.ts` — replaced by the **P3** SSH/Answerer-backed read-only audit pass runner.

Note: a **hard-throw** unconfigured seam (`UnconfiguredAllocator`, the `*AnswererUnconfiguredError` throws) is the _correct_ default — failing loudly is not a stand-in — and is deliberately **not** in the taxonomy, so it needs no allowlist entry. The OSS quota no-op is also not here: P1·0 deleted it (budget enforcement is the universal gate).

## Structural ratchets (Track B wave 3)

These three live in the sibling module `scripts/check-architecture-structure.mjs` (kept separate so `check-architecture.mjs` stays under the 500-line cap). They are heuristic, regex/brace-matching scanners — not a real AST — and each is a **non-regressing ratchet**: the threshold is pinned at or just above the current repo maximum so existing code passes today, and is meant to be tightened in a later wave as the flagged hotspot is refactored. Tightening a cap is the deliverable, not an exception.

- `cyclomatic-complexity-cap`: per-function heuristic complexity (1 + one per `if`/`case`/`&&`/`||`/ternary `?`/`catch`/`for`/`while`; `??`, `?.`, and `?:` are not branches) on `services/orchestrator/src/engine/workflow/**` and `services/orchestrator/src/engine/answerers/**`. **Measured current max: 23** (`runPlannerLoopWorkflow` in `engine/workflow/plannerRun.ts`). **Cap: 25.** Ratchet target: decompose `plannerRun` and lower the cap toward ~15.
- `max-params-cap`: per-function positional parameter count on the same critical directories. **Measured current max: 6** (a step helper in `engine/workflow/helloRun.ts`). **Cap: 6** (pinned at current max). New functions that would exceed it must thread an options object.
- `cross-package-deep-import`: an import may only reach another workspace package through its public entry. Bare `@tanren/<pkg>/src/**` specifiers and relative specifiers that resolve into a _different_ package's tree are flagged. **Two historical violations** (orchestrator state tests importing `../../../db/src/stateEnums.js`) were fixed in this wave by re-exporting `stateEnumLists`/`StateEnumName` from the `@tanren/db` entry and importing via `@tanren/db`; the allowlist is empty.
- `e2e-no-mock-imports` (autonomy-engine §8b): the real-resource `just e2e` gate (`tests/e2e/**`) must drive Tanren ONLY through real external surfaces (the HTTP API + the dashboard) and assert on REAL persisted artifacts. So any file under `tests/e2e/**` that imports a **test fixture / mock / stub / deterministic stand-in** (a specifier under `**/fixtures/**`, or one whose name matches the §8a stub taxonomy — `*Stub`, `Mock*`, `Fake*`, `Noop*`, `deterministic*`, `templated*`) **or** a **non-public internal seam** (`@tanren/*/src/**`, or a path reaching into `services/*/src/**`) is flagged. Allowed imports: the e2e suite's own `lib/` + `cases/`, node builtins, the `@tanren/db` PUBLIC entry (raw artifact reads), and third-party clients (`vitest`/`pg`/`octokit`/`@playwright/test`). This is what makes "the e2e gate cannot pass on a stubbed shell" a mechanical gate rather than a claim. The check lives in `scripts/check-architecture-structure.mjs` and runs through `just architecture` (on the fast path); the credentialed cases themselves run only via `just e2e`. See `docs/operator-guide/e2e.md`.

## Behavior-based tests (no implementationy tests)

Tests assert on **observable outcomes**, not on how the implementation reached them. The user-facing result is the contract; the call sequence used to produce it is not. Prefer, in order:

- the **HTTP response** (status + parsed body) for a route,
- **persisted or returned state** after the operation (the row that was written, the value the function returned, the file it wrote),
- **seam conformance** (a real or fake adapter that satisfies the seam's contract — see the conformance suites),
- **rendered output** (what a CLI command prints, what a component renders).

Mock-call assertions (`toHaveBeenCalledWith`, `.mock.calls`) are allowed only as **secondary corroboration of an external side-effect** that has no observable surface from the test (e.g. "a draft PR was opened against the config repo") — never as the _only_ assertion in a block. A block whose sole assertion is "the collaborator was called" pins the implementation, not the behavior, and breaks under harmless refactors.

This is enforced by `no-mock-only-tests` (in `scripts/check-architecture-structure.mjs`, wired through `just architecture`):

- **Mock-only block:** any `it(...)`/`test(...)` block that contains a mock-call assertion (`toHaveBeenCalled*` or `.mock.calls`) but **no** co-located outcome assertion (`toBe`/`toEqual`/`toMatch`/`toContain`/`toMatchObject`/`toThrow`/`.status`/`.json(`/`.resolves`/… in the same block) is flagged. Every block that checks a mock call must also assert an observable outcome.
- **Module mocking frozen:** any `vi.mock(...)` is flagged. The allowlist is **empty** — module mocking replaces the real seam wholesale and is exactly the implementation-coupling this rule prevents. Adding an entry requires a matching note in the Exception Path below.

The heuristic is a brace-matched line-scanner (no parser), so it is intentionally conservative: it only flags blocks that have a mock-call assertion and zero outcome assertions.

**Templates for new tests:** point reasoning/route tests at the conformance suites under `services/orchestrator/tests/conformance/**` (seam-contract style) and `services/orchestrator/tests/runRoutes.contract.test.ts` (drive a Hono `app` and assert response status/body). For CLI commands, `cli/tests/commands.test.ts` and `cli/tests/productCommands.test.ts` drive the real handlers against a local stub orchestrator (`cli/tests/helpers/stubServer.ts`) and assert the printed JSON plus the recorded request fields by value.

## Exception Path

Prefer refactoring over exceptions. A new exception requires a short entry in this file naming the rule, file path, why the invariant still holds, and the deletion condition. The checker should point at that exact allowlist.

Active exception: `db/migrations/meta/**` is Drizzle-generated migration metadata and may exceed 500 lines. Delete this exception if Drizzle supports split or compact metadata that preserves drift detection.

Active exception: `services/orchestrator/src/engine/answerers/schemas/generated/**` is the JSON Schema mirror emitted by `scripts/answerer-schema-export.mjs` from the Zod sources in the same directory. The drift test at `services/orchestrator/tests/answererSchemaDrift.test.ts` keeps the mirror honest; the file size grows with the Forge tool-call discriminated union so the human-readable diff stays the source of review value. Delete this exception if the generator ever switches to a compact format that keeps PR diffs reviewable.

Active exception: `contracts/json/**` is the unified JSON-Schema mirror emitted by `scripts/contract-schema-export.mjs` from the Zod contract sources (event payloads, state enums, answerer schemas, HTTP request/response, workflow insights) catalogued in `services/orchestrator/src/engine/schemaExport/catalog.ts`. The `contract-schema-drift-check-wired` rule plus the `check:contract-schema-drift` gate keep the mirror honest; individual files may exceed 500 lines (e.g. the Forge answer and run-detail response) so the human-readable diff stays the review surface. Delete this exception if the generator ever switches to a compact format that keeps PR diffs reviewable.

Active exception: `compose.dev.yml` and `compose.prod.yml` mount `/var/run/docker.sock` into `orchestrator` for SPEC-0003 local runner lifecycle metadata. Workload execution still goes through `SshSubstrate`; allocator code may inspect/claim containers but must not run agent workloads through Docker. Delete this exception when P2A-0010 lands the dedicated allocator sidecar and local allocation no longer needs direct Docker Engine access from the orchestrator.
