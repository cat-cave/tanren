# mq-8 — EAGER speculative beam search (build before ready)

**Phase**: full (merge-queue)
**Node ID**: `mq-8`
**Deps**: `mq-4` (partition-scoped leases), `mq-6` (live proof-unit graph)
**Node credit**: **0** until independent audit, full green gates, and merge.

## Purpose and boundary

Add a bounded, deterministic EAGER beam that builds likely dependent integration frontiers after real writer PR heads exist but before their bases are merge-ready. It extends the existing speculative DAG path: `computeReadiness` in `services/orchestrator/src/engine/dag/speculation.ts`, `EventEmittingDagWalker.walk`/`enqueueOne` in `dag/walker.ts`, and the sole `runs.ancestor_stack` decoder in `dag/ancestorStack.ts`.

It uses the current `recordEagerBaseNode` bootstrap in `workflow/plannerRunEagerBaseNode.ts` and the never-discard `BaseShiftCoordinator.rebaseOnto` substrate in `dag/baseShiftCoordinator.ts`; it must not fork runs, branches, or ancestor stacks. This is build-and-proof preparation only: it never creates a land path, calls MergeAuthority, changes a queue entry's authority state, or treats speculative green as ready to merge.

Beam ranking is advisory work selection only; the current batch coordinator remains the sole consumer of merge-queue eligibility.

## Production call graph

Current wake-up is `MergeCoordinatorSubscriber.onRunActivity` → `schedule` → `runChain` in `engine/merge/subscriber.ts` → `BatchMergeCoordinator.coordinate` in `engine/merge/batchCoordinator.ts` → `queue.recoverStaleClaims`/`queue.loadSnapshot` → `formBatch` in `engine/contracts/batchMergeCoordinator.ts`.

The one new production entry point is **`EagerIntegrationBeamPlanner.planAndBuild(projectId)`**, called in that coordinator chain after stale-claim recovery and before its fresh queue snapshot. The planner resolves the current `ancestor_stack` and published writer heads, then calls `IntegrationNodeMaterializer.materialize` in `engine/merge/integrationNodeMaterializer.ts`; exact reusable evidence is evaluated by `IntegrationProofUnitGraph.evaluate` in `engine/dag/integrationProofUnits.ts`.

The unchanged later path is `processBatch` → `PgBatchChecker.checkBatch` → `driveThroughIntegrationNode`/`driveBatchThroughNode` → `driveMultiMemberPass` (`engine/merge/multiMemberAuthorityEmbark.ts`) → existing authority-owned land. The planner cannot call that authority or landing path.

## Contract / data model

Add frozen, strict Zod `EagerBeamPlanV1` in `engine/contracts/eagerBeamPlan.ts`, with `schemaVersion: "eager_beam.v1"`, positive bounded beam width, rank, current full-SHA base, DAG-ordered member full SHAs, `ancestor_stack`, expected `memberKey`, and all six current `proofReuseKey` inputs from `engine/contracts/integrationNodes.ts`. It is invalid unless every member still has a real published head; no caller-supplied score or scope is trusted.

Add `merge_eager_beams` in the next free migration slot at build time: org/project identity (FK to existing `projects`), frontier run/spec identity, plan digest (FK to existing `cas_artifacts`), `integration_node_id` (FK to existing `integration_nodes`), rank, generation, and `building`/`ready`/`stale`/`held` state with timestamps. Unique `(org_id, plan_digest)`; ENABLE and FORCE RLS with the repository org policy. Extend the existing integration-node purpose constraint/type to admit `eager_beam`, retaining `(org_id, member_key)` dedupe rather than adding a parallel node store.

## Provable / callable / visible

Reuse current `integration.node.materialized`, `integration.node.materialization_failed`, `integration.proof_unit.recorded`, `integration.proof_unit.reused`, and `integration.proof.invalidated` evidence. Freeze new `merge.beam.planned` and `merge.beam.stale` payloads in the SP-8 event preflight before this consumer ships; `PgEventStore` remains the only append path.

Expose `GET /orgs/:orgId/projects/:projectId/merge-queue/eager-beams` through the existing `/orgs` report mount in `services/orchestrator/src/routes/experiments/mount.ts`. Add an EAGER beams panel to `services/dashboard/src/routes/mergeQueue/index.tsx`/`MergeQueueBody.tsx`, showing rank, exact base/member SHAs, node/evidence state, and stale reason.

## Fail-closed proof

Invariant: an EAGER result is reusable only for its exact base, ordered member heads, ancestor stack, and six proof-reuse inputs, and it is never merge authority. On malformed ancestry, missing head, materialization mismatch, stale base, or evidence mismatch, mark/retain the beam `held` or `stale`, invalidate evidence, and leave the original dependent run for `BaseShiftCoordinator` rebase/regate; do not enqueue a substitute run or advance queue/land state.

Local verification includes deterministic top-K/tie-break, malformed-stack, base-shift, reuse-key, persistence/RLS, and coordinator-wiring tests. The independent adversarial GO changes a selected base or member SHA after planning while supplying a formerly-green proof; its negative control must show no reuse, no authority embark, and no land, while the original run is held or rebased. The gravest forbidden fail-open is stale speculative proof becoming merge authorization or a base shift discarding the dependent run.

## Size / migration

Estimate 800–950 lines across planner, frozen contract, migration/store, route, dashboard panel, and tests; keep every source file at or below 500 lines. This needs one migration in the next free slot at build time. It touches serial schema ownership (`db/src/schema.ts` plus its focused table module), the shared report mount, and event-preflight files; it does not touch `screens.ts`, `main.ts`, or `mountFeatureRoutes.ts`.

## Acceptance

- A real queued dependent with published heads produces at most K persisted EAGER plans/nodes, deterministically ordered, without becoming merge-ready or landing.
- Re-running unchanged inputs reuses only the exact persisted node/proof; a base/member/reuse-input change makes it stale and uses the existing rebase path.
- Cross-org reads/writes to `merge_eager_beams` fail under FORCE RLS, and the route/dashboard expose only the requesting org's beam state and evidence.
- Local verification and an independently run adversarial GO, including its stale-proof negative control, are green before node credit can change.
