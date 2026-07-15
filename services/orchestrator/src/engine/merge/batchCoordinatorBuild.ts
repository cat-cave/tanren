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
import { PgSpecEscalator } from "./coordinatorEscalate.js";
import { type BuildMergeCoordinatorDeps, buildDriveMerge } from "./coordinatorBuild.js";
import { PgMergeQueueEventEmitter } from "./coordinatorEvents.js";
import { PgMergeQueueModel, PgMergeRunner, PgMergeSettleTransaction } from "./coordinatorPg.js";
import { PgHoldCeilingStore } from "./holdCeilingStore.js";
import { resolveMaxBatchSize } from "./maxBatchSize.js";
import { PgRecoveryEvidencePort } from "./recoveryEvidencePg.js";

export { resolveMaxBatchSize } from "./maxBatchSize.js";

/**
 * apex v87: local both-or-neither settle (`PgMergeSettleTransaction`) opens
 * `PgEventStore` on the worker pool — only legal when the writer declares
 * `localMergeSettleCoTx` (Direct; pool can INSERT `events`). HttpRunStateWriter
 * omits the flag; remote writers use sequential event-first through the writer.
 */
export function canCoTransactMergeSettle(writer: BuildMergeCoordinatorDeps["runStateWriter"]): boolean {
  return writer.localMergeSettleCoTx === true;
}

/** Assemble the production BatchMergeCoordinator (the native-queue driver). */
export function buildBatchMergeCoordinator(deps: BuildMergeCoordinatorDeps): MergeCoordinator {
  const queueModel = new PgMergeQueueModel(deps.pool);
  // ATOMICITY (audit RC-4 #3) + plane-split (apex v87): co-transact event+queue UPDATE
  // ONLY when the writer is Direct (local pool can INSERT events). HttpRunStateWriter
  // omits `tx` → markDequeuedAfterEvent / markInfraBlockedAfterEvent use sequential
  // event-first through the writer-backed emitters (control plane owns the INSERT).
  const settleTx = canCoTransactMergeSettle(deps.runStateWriter)
    ? new PgMergeSettleTransaction(deps.pool, queueModel)
    : undefined;
  return new BatchMergeCoordinator({
    queue: queueModel,
    ...(settleTx !== undefined && { tx: settleTx }),
    // `buildDriveMerge(deps)` already threads `deps.runStateWriter` into the merge
    // stage + the spec-status finalize + the conflict re-execution.
    runner: new PgMergeRunner(buildDriveMerge(deps)),
    checker: new PgBatchChecker({
      pool: deps.pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      // The native batch gate provisions a fresh runner to gate the integration ref.
      allocator: deps.allocator,
      ssh: deps.ssh,
      identitySecretRef: deps.identitySecretRef,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      runStateWriter: deps.runStateWriter,
    }),
    // Audit finding D3/H3 sweep: writer ALWAYS wired (Direct or HTTP); the queue
    // event emitters route every event through it.
    events: new PgMergeQueueEventEmitter(deps.pool, deps.runStateWriter),
    batchEvents: new PgBatchMergeEventEmitter(deps.pool, deps.runStateWriter),
    // The §2c non-bricking conflict escalator (parks an irreconcilable spec at
    // needs_attention) — REUSED verbatim from the native queue, routes through the writer.
    escalator: new PgSpecEscalator(deps.pool, deps.runStateWriter),
    // The batch-gate-fail self-heal (v35 — the strand fix): a GATE-fail bisect culprit
    // (code that passed its own branch gates but breaks integrated) is routed back to the
    // WRITER for rework carrying the gate error as steering, REUSING the never-discard
    // re-plan-with-steering enqueuer + bounded by its own budget — DISTINCT from the
    // conflict-replan route. Always uses the writer.
    gateRework: new PgBatchGateReworkRouter({
      pool: deps.pool,
      runStateWriter: deps.runStateWriter,
    }),
    // Audit RC-7: the DURABLE backing store for both runaway-guard ceilings (per-project
    // consecutive-infra-hold streak + per-entry recoverable-drive attempts), so the counters
    // survive a rolling deploy / crash-loop instead of resetting in a process-local Map.
    holdCeilingStore: new PgHoldCeilingStore(deps.pool),
    // Settlement-time ownership readback: prove receipt runId/replanRunId still owns the
    // exact queue entry's spec in an active status before conflict dequeue.
    recoveryEvidence: new PgRecoveryEvidencePort(deps.pool),
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
