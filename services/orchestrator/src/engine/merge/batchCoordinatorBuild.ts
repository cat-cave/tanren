// The production assembly of the BatchMergeCoordinator (autonomy-engine.md §2d
// — speculative batch-check + bisect), wired from the merge-coordinator subscriber.
// It is the native-queue DRIVER: it forms a batch, proves the prospective merged
// state (`default_branch + batch PRs`) green as a COMBINED unit (the PgBatchChecker:
// speculative integration + the `CodeHost` ref-read seam + native jj/gate execution), then drives
// the SAME per-run merges in DAG order — a bad interaction is bisected to ONE
// PR (recoverable dequeue → re-execution) rather than stalling the batch.
//
// It REUSES the native-queue pieces verbatim — the SAME PgMergeQueueModel (queue + lease),
// the SAME PgMergeRunner over `buildDriveMerge` (the real per-run merge path), the
// SAME PgMergeQueueEventEmitter (advanced / dequeued) — and ADDS the PgBatchChecker +
// PgBatchMergeEventEmitter (merge.batch.*). The max batch size is resolved per-project
// from `projects.config.maxBatchSize` (the config knob, the single source of truth).

import type { MergeCoordinator } from "../contracts/mergeCoordinator.js";
import { PgBatchChecker } from "./batchChecker.js";
import { BatchMergeCoordinator } from "./batchCoordinator.js";
import { PgBatchMergeEventEmitter } from "./batchCoordinatorPg.js";
import { PgBatchGateReworkRouter } from "./batchGateReworkRouter.js";
import { resolveMaxBatchSize } from "./batchMaxSize.js";
import { PgSpecEscalator, requireRecoveryParkWriter } from "./coordinatorEscalate.js";
import { type BuildMergeCoordinatorDeps, buildDriveMerge } from "./coordinatorBuild.js";
import { PgMergeQueueEventEmitter, PgMergeQueueModel, PgMergeRunner } from "./coordinatorPg.js";
import { PgHoldCeilingStore } from "./holdCeilingStore.js";
import { requireRecoveryOwnedSettlementWriter } from "./recoveryOwnership.js";
import { PgMultiMemberAuthorityEvaluator } from "./multiMemberAuthorityGatherPg.js";
import { PgAutonomousRepairRouter } from "./respecRouterPg.js";

/**
 * Assemble the production BatchMergeCoordinator (the native-queue driver).
 * `runStateWriter` must implement RecoveryParkWriter — production Direct/Http always do;
 * {@link requireRecoveryParkWriter} fails loud if a stub lacks park authority.
 */
export function buildBatchMergeCoordinator(deps: BuildMergeCoordinatorDeps): MergeCoordinator {
  const runStateWriter = requireRecoveryParkWriter(deps.runStateWriter);
  const recoverySettlement = requireRecoveryOwnedSettlementWriter(runStateWriter);
  const events = new PgMergeQueueEventEmitter(deps.pool, runStateWriter);
  const queueModel = new PgMergeQueueModel(deps.pool, events);
  return new BatchMergeCoordinator({
    queue: queueModel,
    // `buildDriveMerge(deps)` already threads `deps.runStateWriter` into the merge
    // stage + the spec-status finalize + the conflict re-execution.
    runner: new PgMergeRunner(buildDriveMerge({ ...deps, runStateWriter })),
    checker: new PgBatchChecker({
      pool: deps.pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      // The native batch gate provisions a fresh runner to gate the integration ref.
      allocator: deps.allocator,
      ssh: deps.ssh,
      identitySecretRef: deps.identitySecretRef,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      runStateWriter,
    }),
    authorityEvaluator: new PgMultiMemberAuthorityEvaluator({
      pool: deps.pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      runStateWriter,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    }),
    // Audit finding D3/H3 sweep: writer ALWAYS wired (Direct or HTTP); the queue
    // event emitters route every event through it.
    events,
    batchEvents: new PgBatchMergeEventEmitter(deps.pool, runStateWriter),
    // The §2c non-bricking conflict escalator (parks an irreconcilable spec at
    // needs_attention) — REUSED verbatim from the native queue, routes through the writer.
    escalator: new PgSpecEscalator(deps.pool, runStateWriter),
    // The batch-gate-fail self-heal (v35 — the strand fix): a GATE-fail bisect culprit
    // (code that passed its own branch gates but breaks integrated) is routed back to the
    // WRITER for rework carrying the gate error as steering, REUSING the never-discard
    // re-plan-with-steering enqueuer + bounded by its own budget — DISTINCT from the
    // conflict-replan route. Always uses the writer.
    gateRework: new PgBatchGateReworkRouter({
      pool: deps.pool,
      runStateWriter,
    }),
    // mq-10: the autonomous-repair router. An isolated deterministic-policy member is classified —
    // in-place-repairable → the writer rework above; a PROVEN fixed point → a RespecPacketV1 that
    // re-drives spec authoring on a different agent (materializing a replacement spec); an
    // unclassifiable failure → fail-closed needs-attention. Never a silent drop or infinite requeue.
    repairRouter: new PgAutonomousRepairRouter({ pool: deps.pool }),
    recoverySettlement,
    // Audit RC-7: the DURABLE backing store for both runaway-guard ceilings (per-project
    // consecutive-infra-hold streak + per-entry recoverable-drive attempts), so the counters
    // survive a rolling deploy / crash-loop instead of resetting in a process-local Map.
    holdCeilingStore: new PgHoldCeilingStore(deps.pool),
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
