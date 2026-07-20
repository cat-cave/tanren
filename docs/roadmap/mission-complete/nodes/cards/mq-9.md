# mq-9 — IntegrationGraphScheduler + semantic partitions + dynamic batches

**Phase**: full (merge-queue)
**Node ID**: `mq-9`
**Deps**: `mq-3` (safe-subset solver), `mq-4` (partition leases), `mq-6` (proof-unit graph)
**Node credit**: **0** until independent audit, full green gates, and merge.

## Purpose and boundary

Add the scheduler that turns the live integration graph into dependency-closed, semantically safe batches whose size adapts to queue age, capacity, lease state, and exact proof value. It replaces only the current candidate-selection seam: `BatchMergeCoordinator.coordinate` loads a `PgMergeQueueModel` snapshot in `engine/merge/coordinatorPg.ts` and hands it to pure `formBatch` in `engine/contracts/batchMergeCoordinator.ts`, which today only applies priority, dependency closure, and `maxBatchSize` from `batchMaxSize.ts`.

It builds on, rather than replaces, `PgMergeQueuePartitionStore` in `engine/merge/mergeQueuePartitionStore.ts` and its mq-4 fenced leases, the mq-3 `solveSafeSubset` proposal in `engine/merge/safeSubsetSolver.ts`, and mq-6 `IntegrationProofUnitGraph`. The scheduler neither checks gates nor grants authority: `PgBatchChecker`, `driveMultiMemberPass`, and the existing land flow remain the only proof/authority/land owners.

A semantic decision proposes capacity and isolation; it cannot make a queued entry eligible, leased, checked, or landable.

## Production call graph

Current flow is `MergeCoordinatorSubscriber.runChain` in `engine/merge/subscriber.ts` → `BatchMergeCoordinator.coordinate` → `queue.recoverStaleClaims` → `queue.loadSnapshot` → `formBatch` → `processBatch` → `checkBatchWithInfraRetry` → `PgBatchChecker.checkBatch`/`driveThroughIntegrationNode` → `driveMultiMemberPass` → existing authority land.

The one new production entry point is **`IntegrationGraphScheduler.schedule(snapshot)`**, replacing the direct `formBatch(snapshot, maxBatchSize)` selection call and returning the one proposed batch plus canonical semantic-partition decision for that same fresh snapshot. It derives partition facts from current `merge_queue`/`specs.depends_on` data loaded by `PgMergeQueueModel`, real PR diffs via existing `CodeHost.readDiff` (already consumed by `engine/workflow/reviewMerge/reviewProbeGithub.ts`), current partition leases, and exact proof-node reuse facts.

It may call `formBatch` and `solveSafeSubset` as pure candidate builders; only the unchanged checker and authority path may turn the proposal into a checked or landed batch.

## Contract / data model

Add frozen, strict Zod `IntegrationSchedulePlanV1` in `engine/contracts/integrationSchedulePlan.ts`, with `schemaVersion: "integration_schedule_plan.v1"`, snapshot identity, ordered dependency-closed run IDs and full head/base SHAs, canonical semantic partitions, active lease epochs, and an explainable dynamic-capacity decision (`minimum`, `maximum`, `selected`, age/proof/capacity inputs). Partition classes are closed: `path`, `api`, `behavior`, `design`, `migration`, `shared`, and `all_scopes`; unknown, stale, or unreadable classification is `all_scopes`, never a guessed narrower class. Solver output remains an untrusted proposal.

No migration and no new table: persist the server-derived canonical partition fingerprint through existing `merge_queue.scope_fingerprint` and `merge_queue_partitions` from `0054_merge_queue_partitions_leases.sql`, whose org-scoped policies already ENABLE and FORCE RLS. Reuse existing `integration_nodes` and proof-unit tables for evidence; do not weaken their member-key or proof-reuse-key identity contracts.

## Provable / callable / visible

Reuse `merge.partition.leased`/`merge.partition.released` for fenced ownership, `merge.batch.checking` for the actual selected set/cap, and mq-6 proof-unit recorded/reused/invalidated events. No new event vocabulary is needed; the schedule response is a read model, not an event append bypass.

Expose `GET /orgs/:orgId/projects/:projectId/merge-queue/schedule` from the existing report mount in `services/orchestrator/src/routes/experiments/mount.ts`. Extend the current merge-queue page and `MergeQueueBody.tsx` with semantic partition, selected cap, blockers, lease epoch, and the conservative input that forced serial handling; no new navigation screen.

## Fail-closed proof

Invariant: no two work items may share a batch unless their dependency closure, server-derived semantic facts, current heads/bases, and live partition lease all validate for the same snapshot. Missing/corrupt/stale diff facts become an `all_scopes` serial barrier (or hold when no safe proposal exists); stale lease, snapshot, or head facts leave queue ownership and batch state unchanged. The scheduler cannot call MergeAuthority or any land method.

Local verification covers classifier determinism, dependency closure, dynamic-capacity bounds, stale-snapshot/lease rejection, RLS, and production wiring. The independent adversarial GO's negative control changes `db/migrations/`, `db/src/schema.ts`, or a shared API surface in one candidate while presenting otherwise-disjoint paths: it must be `migration`/`shared`/`all_scopes`, never co-batched with an unrelated member, and must not land. The gravest forbidden fail-open is classifying a shared migration/schema/API change as independent and allowing it to bypass serial proof/authority scrutiny.

## Size / migration

Estimate 650–850 lines across frozen contract, scheduler/classifier, queue-store adaptation, route/dashboard read model, and tests; keep every source file at or below 500 lines. No migration is required. It touches the shared coordinator, queue partition store, report mount, and merge-queue UI; it does not touch `schema.ts`, `screens.ts`, `main.ts`, or `mountFeatureRoutes.ts`.

## Acceptance

- The same snapshot yields the same closed partition plan and bounded batch; age, available capacity, and reusable proof facts alter only the documented cap.
- Unknown/stale diff or semantic data yields a serial `all_scopes` batch or hold, never an optimistic co-batch; lease/snapshot changes reject the proposal.
- A real-PG RLS test proves one org cannot schedule, inspect, or mutate another org's partition data, and the route/dashboard expose only scoped explanations.
- Local verification and an independently run adversarial GO, including the shared-migration/API negative control, are green before node credit can change.
