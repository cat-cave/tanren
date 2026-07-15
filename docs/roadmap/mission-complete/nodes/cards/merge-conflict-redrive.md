# merge-conflict-redrive — clean conflict recovery (PR #928 replacement)

**Phase**: mergequeue Phase 0  
**State at admission**: stale PR #928 (`fix/merge-conflict-dequeue-redrive`, 21
commits / 112 paths) audited unsuitable wholesale; rebuild from
`fix/atomic-recovery-park` (`f0f2c4a6`) as a separate stacked unit.  
**Purpose**: for a bisected ordered batch where `B` is the isolated culprit,
land the entire innocent prefix first, then drive `B` through the same
per-run conflict-recovery path used for base conflicts. Retire `B` only on a
durable exact outcome: live replacement owner receipt, atomic
`RecoveryParkWriter` `parked`, or merge completed. Never fabricate queue
dequeue or `replanned` ownership.

## Dependencies

**Hard build dependencies**

- Atomic recovery park authority (`atomic-recovery-park` card / `f0f2c4a6`):
  `RecoveryParkWriter.parkRecoveryAndDequeue`, sole PgEventStore append path.
- Existing batch coordinator + bisect (`batchCoordinator.ts`,
  `bisectCulprit` / `innocentPrefix`), base-conflict drive
  (`driveBaseConflict`), replan/gate-rework routers, merge queue model.

**Downstream consumers**

- mq-1 signal classification (defers `batchCoordinator*` until this unit lands).
- Merge-queue operator visibility via existing authenticated queue-stat /
  event surfaces (no dashboard/event-vocabulary edits in this unit).

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/merge-conflict-redrive.md`
- `services/orchestrator/src/engine/contracts/conflictResolution.ts`
  (receipt / route-result types only)
- `services/orchestrator/src/engine/contracts/mergeCoordinator.ts`
  (drive outcomes + delete `recoverDequeuedCandidates`)
- `services/orchestrator/src/engine/contracts/batchMergeCoordinator.ts`
  (`BatchGateReworkRouter` return types)
- `services/orchestrator/src/engine/merge/batchCoordinator.ts`
- `services/orchestrator/src/engine/merge/batchCoordinatorSettle.ts`
- `services/orchestrator/src/engine/merge/batchCoordinatorBuild.ts`
  (recovery-evidence / park wiring only)
- `services/orchestrator/src/engine/merge/batchGateReworkRouter.ts`
- `services/orchestrator/src/engine/merge/recoveryOwnership.ts`
- `services/orchestrator/src/engine/merge/recoveryEvidencePg.ts`
- `services/orchestrator/src/engine/merge/coordinator.ts`
  (delete production-dead `EventEmittingMergeCoordinator`; keep pure settle helpers)
- `services/orchestrator/src/engine/merge/coordinatorPg.ts`
  (delete `recoverDequeuedCandidates` SQL/facade)
- `services/orchestrator/src/engine/merge/coordinatorEscalate.ts`
- `services/orchestrator/src/engine/merge/coordinatorBuild.ts`
  (conflict outcome carries recovery receipt)
- `services/orchestrator/src/engine/merge/driveConflictResolve.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/replanRouter.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/gateReworkRouter.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/resolver.ts`
  (typed replan/rework disposition wiring)
- `services/orchestrator/src/engine/workflow/reviewMerge/mergeDispatchTypes.ts`
  (typed recovery fields only if required by drive outcome)
- Related focused tests under `services/orchestrator/tests/**` for the above

## Shared-resource leases, not owned paths

Do **not** edit currently leased surfaces:

- mq-1: event registry/schemas/sensitivity/default severity,
  `db/src/eventTypesSeed.ts`, merge-queue route/body, `mountFeatureRoutes.ts`
- in-1: migration 0041, drizzle journal/meta/schema exports/core indexes,
  integration lifecycle files
- rv-4: behavior coverage/selection files
- dashboard PR #856 repair worktree

No migration. No new store/authority. No dashboard/UI/event-vocabulary edits.

## Consumes

- `RecoveryParkWriter.parkRecoveryAndDequeue` (atomic park + ordered events +
  dequeue on one org-scoped transaction).
- Exact ownership tuple: `orgId + projectId + queueId + runId + specId`.
- `PgEventStore` / run-state writer append as the only event path.
- Bisect `innocentPrefix` + existing `MergeRunner.driveMerge`.

## Produces

1. **Prefix-first conflict recovery**: for ordered `[A, B]` with isolated culprit
   `B`, merge innocent prefix `A` through the normal merge path; only after
   explicit full-prefix success drive `B` against the newly-current base.
2. **Exact retirement**: dequeue only after
   - verified live replacement owner (same org/project/spec; enqueued replan
     carries planner task + run receipt), or
   - `RecoveryParkWriter` returns `parked`, or
   - merge completed.
3. **Fail-closed parking**: `parking_failed` + `queueDisposition: retained`
   releases/paces retry and never emits dequeue. Transport uncertainty must
   read back or retry; never fabricate queue state.
4. **Typed routers**: gate-rework / replan return
   `owned | parking_required | terminal_noop` (plus parking_failed only when a
   sole park attempt was delegated and failed). They do **not** mutate
   needs-attention separately from queue retirement.
5. **Deletions**: full removal of `recoverDequeuedCandidates` (contract, SQL,
   PG/facade/fakes, obsolete tests). Delete or reduce
   `EventEmittingMergeCoordinator` to pure settlement helpers.

Suggested receipt:

```ts
type RecoveryRunReceipt =
  | { kind: "enqueued"; replanRunId: string; plannerTaskId: string }
  | { kind: "already_running"; runId: string };
```

`SpecNotRunnableError` alone is never ownership — query and prove the exact
active run.

## Negative controls

- Culprit drive never begins if the innocent prefix is incomplete (hold / infra /
  retained / uncertain stops processing).
- Wrong org/project/spec/run/task/status fail closed at ownership verification.
- Atomic park emits no second dequeue/event.
- Empty gather, fixed point, enqueue failure, or unresolved resolver without a
  durable owner routes to atomic parking — never fabricated `replanned`.
- Dropped-ack / transport uncertainty: idempotent readback; never false-dequeue.
- Authenticated queue-stat surface remains truthful via existing reads.

## Validation

- Focused affected typecheck + tests while authoring.
- Mutation-sensitive ordering / receipt / retained negatives.
- Real-Postgres/RLS: exact successor owner, wrong-owner rejection, dropped-ack
  idempotence, loud retained split state (reuse recovery-park integration style).
- Every source/test/doc ≤ 500 lines (or documented exception).
- Local commit only after narrow checks green. Root runs full gates before push.

## Contributor / branch context

- Branch: `fix/merge-conflict-redrive-clean-replacement`
- Base: `f0f2c4a6` (`fix/atomic-recovery-park`)
- Worktree: `.codex/worktrees/pr-928-clean-replacement`
- Never cherry-pick or merge `fix/merge-conflict-dequeue-redrive`
