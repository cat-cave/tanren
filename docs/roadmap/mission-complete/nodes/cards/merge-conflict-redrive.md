# merge-conflict-redrive — clean conflict recovery (PR #928 replacement)

**Phase**: mergequeue Phase 0
**State at admission**: stale PR #928 (`fix/merge-conflict-dequeue-redrive`, 21
commits / 112 paths) audited unsuitable wholesale; rebuild from
`fix/atomic-recovery-park` (`f0f2c4a6`) as a separate stacked unit.
**State after second convergence redrive (2026-07-15)**: all four exact-head P1
findings are implemented and the affected, real-Postgres, `just fast-check`, and
`just ci` gates are green.
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
- `justfile` (`db-rls-smoke` recovery proof cohort only)
- `services/orchestrator/src/engine/contracts/batchMergeCoordinator.ts`
- `services/orchestrator/src/engine/contracts/changePercolation.ts`
- `services/orchestrator/src/engine/contracts/conflictResolution.ts`
- `services/orchestrator/src/engine/contracts/index.ts`
- `services/orchestrator/src/engine/contracts/mergeCoordinator.ts`
- `services/orchestrator/src/engine/contracts/recoveryPreparation.ts`
- `services/orchestrator/src/engine/contracts/runStateAtomicSeam.ts`
- `services/orchestrator/src/engine/contracts/runStateWriter.ts`
- `services/orchestrator/src/engine/dag/baseShiftCoordinator.ts`
- `services/orchestrator/src/engine/dag/baseShiftCoordinatorPg.ts`
- `services/orchestrator/src/engine/dag/baseShiftLiveResolve.ts`
- `services/orchestrator/src/engine/dag/baseShiftLiveSeams.ts`
- `services/orchestrator/src/engine/dag/baseShiftPorts.ts`
- `services/orchestrator/src/engine/dag/baseShiftRebaseHook.ts`
- `services/orchestrator/src/engine/dag/baseShiftRecovery.ts`
- `services/orchestrator/src/engine/dag/percolation.ts`
- `services/orchestrator/src/engine/dag/percolationBuild.ts`
- `services/orchestrator/src/engine/dag/percolationOperation.ts`
- `services/orchestrator/src/engine/dag/percolationWrites.ts`
- `services/orchestrator/src/engine/merge/batchCoordinator.ts`
- `services/orchestrator/src/engine/merge/batchCoordinatorBuild.ts`
- `services/orchestrator/src/engine/merge/batchCoordinatorSettle.ts`
- `services/orchestrator/src/engine/merge/batchGateReworkRouter.ts`
- `services/orchestrator/src/engine/merge/batchInfraEscalate.ts`
- `services/orchestrator/src/engine/merge/batchInfraHoldCeiling.ts`
- `services/orchestrator/src/engine/merge/coordinator.ts`
- `services/orchestrator/src/engine/merge/coordinatorBuild.ts`
- `services/orchestrator/src/engine/merge/coordinatorEscalate.ts`
- `services/orchestrator/src/engine/merge/coordinatorEvents.ts`
- `services/orchestrator/src/engine/merge/coordinatorPg.ts`
- `services/orchestrator/src/engine/merge/driveConflictResolve.ts`
- `services/orchestrator/src/engine/merge/driveConflictResolveJj.ts`
- `services/orchestrator/src/engine/merge/driveConflictVerdict.ts`
- `services/orchestrator/src/engine/merge/driveReGateRework.ts`
- `services/orchestrator/src/engine/merge/infraNonRecovery.ts`
- `services/orchestrator/src/engine/merge/missingRequiredCredential.ts` (deleted)
- `services/orchestrator/src/engine/merge/parkSettle.ts`
- `services/orchestrator/src/engine/merge/recoveryEvidencePg.ts`
- `services/orchestrator/src/engine/merge/recoveryOwnedQueueSettlement.ts`
- `services/orchestrator/src/engine/merge/recoveryOwnership.ts`
- `services/orchestrator/src/engine/merge/recoveryReceiptFingerprint.ts`
- `services/orchestrator/src/engine/merge/recoveryRouteSettlement.ts`
- `services/orchestrator/src/engine/merge/subscriber.ts`
- `services/orchestrator/src/engine/merge/subscriberQueueDiscoverySql.ts` (deleted)
- `services/orchestrator/src/engine/worker/directRunStateWriter.ts`
- `services/orchestrator/src/engine/worker/httpRunStateWriter.ts`
- `services/orchestrator/src/engine/worker/recoveryParkAtomic.ts`
- `services/orchestrator/src/engine/worker/recoveryPreparationAtomic.ts`
- `services/orchestrator/src/engine/workflow/plannerRun.ts`
- `services/orchestrator/src/engine/workflow/plannerRunSeams.ts`
- `services/orchestrator/src/engine/workflow/projectSpec.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/replanRouter.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/gateReworkRouter.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/index.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/resolver.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/mergeDispatchTypes.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/mergeDispatcher.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/mergeLandPaths.ts`
- `services/orchestrator/src/routes/internal/runStateAtomicWrites.ts`
- Related focused tests only in these path families:
  `services/orchestrator/tests/batchCoordinator*.test.ts`,
  `batchGateReworkRouter.test.ts`, `batchMergeCoordinator*.test.ts`,
  `conflictResolver.test.ts`, `coordinatorBuildDriveScope.test.ts`,
  `dagBaseShift*.test.ts`, `dagPercolation*.test.ts`,
  `dagRecoverySettlement.test.ts`, `dagWalker*.test.ts`,
  `driveConflictResolve.test.ts`, `driveMergePercolationYield.test.ts`,
  `gateReworkRouter.test.ts`, `markDequeuedAfterEventAtomicity.test.ts`,
  `mergeClaimLease.test.ts`, `mergeCoordinator*.test.ts`,
  `mergeLand*.test.ts`, `mergeQueueDequeuedRecovery*.test.ts` (deleted),
  `mergeSelectNext.test.ts`, `parkSettle.test.ts`, `recovery*.test.ts`,
  `terminalInfrastructureRecovery.rls.integration.test.ts`,
  `services/orchestrator/tests/fixtures/terminalInfrastructureRecovery.ts`,
  `reviewMergeP2a.test.ts`, `services/orchestrator/tests/conformance/**`, and
  `services/orchestrator/tests/fixtures/scriptedRecovery*.ts`.

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

## Second convergence closure

1. **Atomic successor preparation**: `RecoveryPreparationWriter` is the only
   replan/rework preparation authority. It locks the exact tenant/project/spec/
   old-run/queue tuple, admits only `open|in_flight|review`, and commits steering,
   guarded reopen, one successor run/task/job, and both canonical routing events
   in one transaction. Stable event idempotency keys provide exact replay and the
   HTTP path performs durable readback after every ambiguous response.
2. **Old queue retirement before success**: `PgRecoveryRouteSettler` invokes
   `settleOwnedRecoveryAndDequeue` for owned receipts. Both base-shift and
   `PgPercolationSettler` clear their marker only after that atomic settlement;
   a lost acknowledgement retains the marker until exact replay proves the queue
   was retired.
3. **Receipt-bound replay**: fresh owned settlement stores a SHA-256 fingerprint
   over the exact old tuple, successor run/task/kind, and dequeue reason in the
   canonical `merge.dequeued` event's existing `idempotency_key`. Already-dequeued
   replay accepts only that fingerprint, including after the successor terminates;
   wrong receipts fail `receipt_mismatch`. No migration or parallel registry.
4. **Infrastructure ownership**: missing GitHub credentials emit a durable alert,
   release any claim, keep the candidate active, and pace re-drive; credential
   repair notifications schedule the same active project queue. Ambiguous merge
   state goes through the atomic needs-attention park and never through a bare
   `blocked` dequeue. Obsolete dequeued discovery and the unused supersede API are
   deleted.
5. **Plane parity**: Direct and HTTP use the same preparation, park, and owned-
   settlement operations. The former local co-transaction branch and advertised
   settlement-order divergence are removed.

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

- Focused recovery endpoint, owned-settlement endpoint, and router/recovery unit
  cohorts: 47 tests passed.
- `just affected-typecheck`: passed. `just affected-test`: 237 files passed, 21
  skipped; 1,904 tests passed, 154 skipped.
- Real PostgreSQL 18 with RLS enabled: the preparation, recovery-park, and terminal
  infrastructure cohorts passed 19/19 tests. Coverage includes exact successor
  ownership, wrong receipt/tuple rejection, commit-response loss, replay after a
  successor terminates, queue-before-marker settlement, credential repair, and
  atomic ambiguous-state parking.
- `just fast-check`: passed, including format, lint, architecture, dependency,
  spelling, typecheck, full test/coverage, and compose validation.
- `just ci`: passed, including all `fast-check` stages and the full build.
- Every changed source/test/doc remains at or below 500 lines; architecture checks
  passed. Shared compose smoke was intentionally not run for this replacement
  task.

## Contributor / branch context

- Branch: `fix/merge-conflict-redrive-clean-replacement`
- Base: `e065315b` (`origin/main` after notification ordering #955)
- Worktree: `.codex/worktrees/pr-928-clean-replacement`
- Never cherry-pick or merge `fix/merge-conflict-dequeue-redrive`
