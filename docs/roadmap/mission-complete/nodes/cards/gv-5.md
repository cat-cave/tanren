# gv-5 — truthful budget-held safety repair

**Phase**: governance Phase 0 (safety repairs) · `sm` (small mechanical)
**Base**: `origin/main` `e6a6ded0c813b61f1ec6634158b30471f48b14f0`
**Branch**: `mission/gv-5-truthful-budget`
**Worktree**: `.codex/worktrees/gv-5-truthful-budget`

**Canonical mapping**: the ordered governance MVP safety-repair list maps
`gv-1..6` to audit-posture guard, strict simulated-review publication, real
policy/gate hashes, transitive retarget, **truthful budget-held event**, and
notification safety. This card owns only the fifth repair. The later governance
budget-envelope/reservation/pause-episode subsystem remains out of scope.

**Purpose**: remove the live lie where every `dag.budget.paused` event reports
`readyHeldBack: 0` even when eligible specs were ready to run. The production
walker must plan the current snapshot before the budget short-circuit and report
the exact number of otherwise-eligible ready specs stopped by the budget gate.
The existing cost ledger + `PgBudgetGate` remain the sole budget truth; the
existing event log remains the sole durable observation store.

## Dependencies

**Spine / shared contracts (read-only)**

- SP-8's already-registered `dag.budget.paused` event and strict payload schema.
- `PgEventStore` as the sole event append seam.
- The existing `DagSnapshot` + lifecycle projection and
  `planSpeculativeDagTick` readiness semantics.

**Production surfaces reused, not replaced**

- `PgBudgetGate` is the one authority for effective ceiling, real spend, and
  fail-closed state.
- `GET /orgs/:orgId/projects/:projectId/budget` is the already-mounted,
  org/project-scoped observation surface.
- `/budget` is the already-mounted dashboard Budget Control Center.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/gv-5.md`
- `services/orchestrator/src/engine/dag/walker.ts`
- `services/orchestrator/src/engine/dag/budgetPause.ts` (new)
- `services/orchestrator/src/engine/dag/budgetPauseObservation.ts` (new)
- `services/orchestrator/src/routes/projects/budget.ts`
- `services/orchestrator/tests/conformance/dagWalkerConformance.ts`
- `services/orchestrator/tests/conformance/dagWalker.conformance.test.ts`
- `services/orchestrator/tests/helpers/routesPool.ts` (budget-pause event fixture
  support only)
- `services/orchestrator/tests/budgetRoutes.test.ts`
- `services/orchestrator/tests/budgetPauseObservation.rls.integration.test.ts`
  (new)
- `services/dashboard/src/api/budget.ts`
- `services/dashboard/src/components/budget/BudgetBody.tsx`
- `services/dashboard/tests/budget.render.test.ts`

## Shared-resource leases, not owned paths

None. Do not edit migrations, migration metadata, the event registry/schema,
sensitivity/default-severity/generated event vocabulary, `mountFeatureRoutes`,
dashboard `screens.ts`/routes/nav, `main.ts`, or any active in-1, rv-4, gv-1,
gv-4, mq-1, or PR #928 replacement path. The existing event and mounted
HTTP/UI surfaces make new shared wiring unnecessary.

## Consumes

- `planSpeculativeDagTick(...)` as the sole readiness computation.
- `shouldPauseOnBudget(...)` as the sole pause decision.
- Existing `DagEventEmitter.emitBudgetPaused(...)` and
  `dag.budget.paused.readyHeldBack` payload field.
- Org-scoped `events` rows as a read projection of the latest durable pause
  observation; this projection never decides whether a project is paused.

## Produces

### Engine + named proof

- The walker computes one canonical tick plan before checking the budget pause.
- On a pause, `readyHeldBack` equals every eligible ready spec that the budget
  gate prevented from enqueueing: `plan.toEnqueue.length +
plan.readyHeldBack`. Dependency-blocked and depth-cap-held specs are excluded.
- No spec is enqueued while paused.
- The named live proof remains `dag.budget.paused`; no parallel event is added.

### HTTP

`GET /orgs/:orgId/projects/:projectId/budget` retains the effective budget view
and adds a nullable latest-pause observation containing:

- `eventType: "dag.budget.paused"`
- `readyHeldBack`
- `observedAt`

The observation is read under the requested org scope and only for the bound
project. Wrong-org/project requests remain denied without metadata leakage. A
paused budget with no walker event yet returns `pauseObservation: null`, never a
fabricated zero.

### UI

The existing halted-on-budget banner renders the latest durable held-ready
count and observation time. If the walker has not emitted a pause proof yet, the
banner says the proof is pending instead of displaying zero or claiming no work
was held.

## Behavior proof

Positive:

1. Two eligible roots plus one dependency-blocked spec at an exhausted ceiling:
   no enqueue; `dag.budget.paused.readyHeldBack === 2`.
2. Concurrency headroom of one with multiple eligible roots still reports all
   budget-held ready specs, not only the one that would fit this tick.
3. The org-scoped budget GET returns the latest durable pause count and the UI
   visibly renders it.

Negative / former-bug mutation:

4. Replacing the walker's computed count with the former literal `0` fails
   conformance; replacing the durable count with `0` at either projection layer
   fails the route or render proof.
5. A blocked spec does not inflate the count; a wrong-org event cannot appear in
   the HTTP response.
6. A reached ceiling with no persisted pause event renders “pause proof pending,”
   never `0 held`.

## Validation

- Focused walker conformance + budget route + dashboard render tests.
- Real-Postgres RLS proof for the pause observation projection.
- `just affected-typecheck` + `just affected-test`, then `just fast-check`,
  `just ci`, and `just smoke` before handoff.
- All touched source/docs files remain below 500 lines.

## Serialization

No shared-resource lease is required. If implementation discovery proves a
shared registry/mount/nav/event/migration edit necessary, stop and request an
exact root lease before touching it.
