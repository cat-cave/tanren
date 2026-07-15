# PR-856 — Run-detail stream integrity convergence

**Phase**: consumer repair
**Owns**:

- `services/dashboard/src/api/**` runtime response decoders and their owned mirror types
- `services/dashboard/src/client/runStream*.ts` and `runCostModel.ts`
- `services/dashboard/src/components/runDetail/**`
- `services/dashboard/src/routes/runs/**`
- dashboard tests for the owned client, BFF, and run-detail surface
- dashboard route fixtures affected by the strict write-response cutover
- `services/orchestrator/src/routes/runs/**`
- orchestrator run-detail SSE contract, route tests, and `tests/helpers/runRoutesPool.ts`
- orchestrator run-read row-schema tests and repository conformance harness
- `services/orchestrator/src/engine/schemaExport/catalog.ts`
- generated `contracts/json/http/` run-detail/SSE artifacts and `services/dashboard/src/api/http.gen.ts`
- `scripts/gen-dashboard-types.mjs` and its drift test (generated-file line-cap formatting only)
- `docs/contracts/run-detail-api.md`
- this ownership card

**Consumes**: the merged run/event/cost contracts and the existing org/project-scoped run-detail read authority.

**Produces**: one strict, resumable run-detail stream contract shared by the orchestrator, dashboard BFF, SSR payload, and browser island. The contract carries stable run/project/task identity, exact accounting, canonical status/outcome vocabulary, an advancing cursor, and an explicit drained frame.

**What**: Clean-replace the loose browser-only stream handling with a server-to-DOM integrity boundary. Every known frame is decoded in full before any mutation, replay is exact and collision-safe, terminal workflow truth remains distinct from transport/accounting completion, and the stream closes only after a valid drained frame proves the final post-terminal read.

**Why**: A run detail that silently accepts partial, cross-run, unsafe-number, or truncated data only imitates an operational view. The autonomous loop needs a truthful visible surface whose displayed state is reproducible from the same typed records used by the engine.

**How**: Use shared runtime schemas and one exact aggregation model for SSR and streaming. Bind every frame to the SSR-rendered identity, order rows by the canonical bigserial cursor, retry transient upstream failures without converting them to empty success, and remove correctness timers and parallel loose-cast aggregation paths.

**Test plan**: Contract fixtures cover every frame, mixed-frame atomicity, exact decimal/token accounting, replay/collision handling, delayed reconnect after terminal status, malformed and post-terminal drained frames, SSR-terminal initialization, transient proxy outages, exact close behavior, and malformed successful HTTP bodies. Run affected checks, `just fast-check`, and `just ci`; the exact-stack `just smoke` remains required once the trustworthy smoke lane lands.

**Quality bar**: No `as`-cast success body, unsafe numeric identifier/accounting conversion, timer-defined completeness, or split SSR/client aggregation remains in the owned path. Source, config, and docs files stay below 500 lines.

**Real-functionality validation**: Against the exact stack, interrupt the browser stream after terminal status but before final accounting, restore it, and prove the UI reconnects from its cursor, receives the missing deltas plus a matching drained receipt, updates every derivative atomically, and closes exactly once.

**Worktree-isolation safety**: All writes are confined to the PR #856 worktree. The expanded orchestrator route/contract and contract-doc paths are serialized to this branch until it lands; no migration, event registry, navigation, `screens.ts`, or `main.ts` file is owned.
