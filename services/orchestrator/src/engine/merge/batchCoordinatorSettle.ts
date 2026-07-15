// Non-merged drive-outcome SETTLE mapping for BatchMergeCoordinator.
// Owner-aware retirement: conflict/failed/gate-fail only leave the queue after
// a durable replacement owner or RecoveryParkWriter parked. parking_failed with
// retained never emits dequeue.

import type { BatchCheckVerdict, BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { GateReworkRouteResult, ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import type {
  CoordinateResult,
  DequeueReason,
  MergeDriveOutcome,
  MergeQueueEntry,
  MergeQueueModel,
  MergeRunner,
} from "../contracts/mergeCoordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";
import { isAmbiguousMergeError } from "../providers/mergeOutcomeErrors.js";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter, type MergeSettleTransaction } from "./coordinator.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";
import {
  holdOrHaltRecoverableDrive,
  type RecoverableDriveHoldCeiling,
  type RecoverableDriveHoldResult,
} from "./recoverableDriveHold.js";
import { verifyRecoveryOwnership, type RecoveryEvidencePort } from "./recoveryOwnership.js";
import { settleFromParkOutcome } from "./parkSettle.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** How long after a transient batch drive throw the subscriber re-drives the project. */
export const BATCH_DRIVE_INFRA_RETRY_AFTER_MS = 3000;

export type BatchDriveInfraHold =
  | { kind: "infra_hold"; message: string; retryAfterMs: number; entry?: MergeQueueEntry }
  | { kind: "infra_terminal"; message: string; entry: MergeQueueEntry; terminalKind: "ambiguous_merge_state" };

export interface BatchSettleDeps {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  escalator: SpecEscalator;
  gateRework?: BatchGateReworkRouter;
  tx?: MergeSettleTransaction;
  recoverableDriveHolds?: RecoverableDriveHoldCeiling;
  /** Settlement ownership readback. Absent ⇒ conflict parks fail-closed. */
  recoveryEvidence?: RecoveryEvidencePort;
}

/**
 * GATE-fail bisect culprit only. Spec-vs-spec CONFLICT culprits are driven via
 * {@link driveConflictCulprit}, never settled here.
 */
export async function settleBisectCulprit(
  deps: BatchSettleDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  isGateFail: boolean,
  gateError: string,
  failMessage: string,
): Promise<"dequeued" | "retained"> {
  if (!isGateFail) {
    // Defensive: conflict culprits must not reach here.
    log.error("settleBisectCulprit invoked for non-gate-fail culprit — parking", {
      projectId,
      specId: culprit.specId,
    });
  }
  if (isGateFail && deps.gateRework !== undefined) {
    const recovery = await deps.gateRework.routeGateFailToRework({ projectId, culprit, gateError });
    const settled = await settleWriterOwnedOrPark(
      deps,
      projectId,
      culprit,
      recovery,
      `integrated-tree gate failure handed to writer rework: ${failMessage}`,
      failMessage,
    );
    if (settled.action === "retain") {
      await deps.queue.releaseClaim(culprit.queueId);
      log.error("gate-fail settle retained queue entry after parking_failed", {
        projectId,
        specId: culprit.specId,
        message: settled.message,
      });
      return "retained";
    }
    if (settled.reason === "needs_attention" && settled.alreadyDequeued) {
      return "dequeued";
    }
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry: culprit,
      reason: settled.reason,
      message: settled.message,
      tx: deps.tx,
    });
    return "dequeued";
  }
  const message = `failed integrated-tree gate has no writer-rework owner: ${failMessage}`;
  const park = await deps.escalator.escalate({ projectId, entry: culprit, message });
  const settled = settleFromParkOutcome(park, message);
  if (settled.action === "retain") {
    await deps.queue.releaseClaim(culprit.queueId);
    return "retained";
  }
  if (!settled.alreadyDequeued) {
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry: culprit,
      reason: settled.reason,
      message: settled.message,
      tx: deps.tx,
    });
  }
  return "dequeued";
}

export interface BatchBaseConflictDeps extends BatchSettleDeps {
  runner: MergeRunner;
}

export async function holdOnRetriableDriveThrow(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  error: unknown,
): Promise<BatchDriveInfraHold | undefined> {
  if (isAmbiguousMergeError(error)) {
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return {
      kind: "infra_terminal",
      message: `merge drive state ambiguous; auto-retry could double-merge: ${String(error)}`,
      entry,
      terminalKind: "ambiguous_merge_state",
    };
  }
  if (!isRetriableInfraError(error)) return undefined;
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  await deps.queue.releaseClaim(entry.queueId);
  log.warn(
    "merge drive threw a transient infra error; holding + re-driving (entry stays queued)",
    { projectId, specId: entry.specId },
    error,
  );
  return {
    kind: "infra_hold",
    message: `merge drive threw transient infra error: ${String(error)}`,
    retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS,
    entry,
  };
}

type WriterSettle =
  | { action: "dequeue"; reason: DequeueReason; message: string; alreadyDequeued?: boolean }
  | { action: "retain"; message: string; retryAfterMs: number };

/** Owned writer receipt → superseded dequeue; else RecoveryParkWriter. */
async function settleWriterOwnedOrPark(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  recovery: GateReworkRouteResult,
  ownedMessage: string,
  failMessage: string,
): Promise<WriterSettle> {
  if (recovery.kind === "owned") {
    const verified = await verifyRecoveryOwnership({
      evidence: deps.recoveryEvidence,
      expectedSpecId: entry.specId,
      receipt: recovery.receipt,
      contextMessage: failMessage,
    });
    if (verified.ok) {
      return { action: "dequeue", reason: "superseded", message: ownedMessage };
    }
    const park = await deps.escalator.escalate({ projectId, entry, message: verified.message });
    const settled = settleFromParkOutcome(park, verified.message);
    if (settled.action === "retain") return settled;
    return {
      action: "dequeue",
      reason: "needs_attention",
      message: settled.message,
      alreadyDequeued: settled.alreadyDequeued === true,
    };
  }
  if (recovery.kind === "terminal_noop") {
    return {
      action: "dequeue",
      reason: "superseded",
      message: `${failMessage} (concurrent terminal ${recovery.status})`,
    };
  }
  if (recovery.kind === "parking_failed") {
    return {
      action: "retain",
      message: recovery.message,
      retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS,
    };
  }
  // parking_required
  const park = await deps.escalator.escalate({ projectId, entry, message: recovery.message });
  const settled = settleFromParkOutcome(park, recovery.message);
  if (settled.action === "retain") return settled;
  return {
    action: "dequeue",
    reason: "needs_attention",
    message: settled.message,
    alreadyDequeued: settled.alreadyDequeued === true,
  };
}

export async function settleDriveOutcome(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  outcome: Exclude<MergeDriveOutcome, { kind: "merged" }>,
): Promise<"dequeued" | RecoverableDriveHoldResult> {
  if (outcome.kind === "needs_attention") {
    return settleNeedsAttention(deps, projectId, entry, outcome);
  }

  if (outcome.kind === "re_gate_pending") {
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    await deps.queue.releaseClaim(entry.queueId);
    return { kind: "held", retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS };
  }

  if (outcome.kind === "blocked") {
    const ceiling = deps.recoverableDriveHolds;
    if (ceiling !== undefined) {
      return holdOrHaltRecoverableDrive({ ceiling, queue: deps.queue, events: deps.events, projectId, entry, outcome });
    }
  }

  if (outcome.kind === "failed") {
    const result = await settleFailedDrive(deps, projectId, entry, outcome.message);
    return result === "retained" ? { kind: "held", retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS } : "dequeued";
  }

  if (outcome.kind === "conflict") {
    return settleConflictOwned(deps, projectId, entry, outcome.message, outcome.recovery);
  }

  // Remaining kinds without a dedicated arm fail closed via park.
  const message = `unhandled non-merged drive outcome ${(outcome as { kind: string }).kind}`;
  const park = await deps.escalator.escalate({ projectId, entry, message });
  const settled = settleFromParkOutcome(park, message);
  if (settled.action === "retain") {
    await deps.queue.releaseClaim(entry.queueId);
    return { kind: "held", retryAfterMs: settled.retryAfterMs };
  }
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  return "dequeued";
}

async function settleNeedsAttention(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  outcome: Extract<MergeDriveOutcome, { kind: "needs_attention" }>,
): Promise<"dequeued" | RecoverableDriveHoldResult> {
  if (outcome.parking === "terminal_noop") {
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry,
      reason: "superseded",
      message: outcome.message,
      tx: deps.tx,
    });
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return "dequeued";
  }
  if (outcome.parking === "parking_failed") {
    await deps.queue.releaseClaim(entry.queueId);
    return { kind: "held", retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS };
  }
  if (outcome.parking === "complete") {
    // Already parked outside RecoveryParkWriter — emit dequeue only.
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry,
      reason: "needs_attention",
      message: outcome.message,
      tx: deps.tx,
    });
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return "dequeued";
  }
  // required
  const park = await deps.escalator.escalate({ projectId, entry, message: outcome.message });
  const settled = settleFromParkOutcome(park, outcome.message);
  if (settled.action === "retain") {
    await deps.queue.releaseClaim(entry.queueId);
    log.error("needs_attention settle retained queue entry after parking_failed", {
      projectId,
      specId: entry.specId,
      message: settled.message,
    });
    return { kind: "held", retryAfterMs: settled.retryAfterMs };
  }
  if (!settled.alreadyDequeued) {
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry,
      reason: settled.reason,
      message: settled.message,
      tx: deps.tx,
    });
  }
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  return "dequeued";
}

async function settleConflictOwned(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  message: string,
  recovery: ConflictRecoveryReceipt,
): Promise<"dequeued" | RecoverableDriveHoldResult> {
  const verified = await verifyRecoveryOwnership({
    evidence: deps.recoveryEvidence,
    expectedSpecId: entry.specId,
    receipt: recovery,
    contextMessage: message,
  });
  if (!verified.ok) {
    const park = await deps.escalator.escalate({ projectId, entry, message: verified.message });
    const settled = settleFromParkOutcome(park, verified.message);
    if (settled.action === "retain") {
      await deps.queue.releaseClaim(entry.queueId);
      log.error("conflict ownership fail retained queue entry after parking_failed", {
        projectId,
        specId: entry.specId,
        message: settled.message,
      });
      return { kind: "held", retryAfterMs: settled.retryAfterMs };
    }
    if (!settled.alreadyDequeued) {
      await markDequeuedAfterEvent({
        queue: deps.queue,
        events: deps.events,
        projectId,
        entry,
        reason: settled.reason,
        message: settled.message,
        tx: deps.tx,
      });
    }
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return "dequeued";
  }
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  await markDequeuedAfterEvent({
    queue: deps.queue,
    events: deps.events,
    projectId,
    entry,
    reason: "conflict",
    message,
    tx: deps.tx,
  });
  return "dequeued";
}

export async function driveBaseConflict(
  deps: BatchBaseConflictDeps,
  projectId: string,
  batch: ReadonlyArray<MergeQueueEntry>,
  verdict: Extract<BatchCheckVerdict, { result: "conflict" }>,
  queueDepth: number,
): Promise<CoordinateResult | BatchDriveInfraHold> {
  const culpritSpecId = verdict.conflictBetween?.specId;
  const culprit = batch.find((e) => e.specId === culpritSpecId);
  if (culprit === undefined) {
    log.warn("base-conflict verdict named a spec not in the formed batch — holding (no dequeue)", {
      projectId,
      culpritSpecId: String(culpritSpecId),
      message: verdict.message,
    });
    return { projectId, holdReason: "all_blocked", queueDepth };
  }
  return driveConflictCulprit(deps, projectId, culprit, queueDepth);
}

/**
 * Drive an already-identified conflict culprit through runner.driveMerge + settle.
 * Shared by base-conflict short-circuit and spec-vs-spec bisect tail.
 */
export async function driveConflictCulprit(
  deps: BatchBaseConflictDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  queueDepth: number,
): Promise<CoordinateResult | BatchDriveInfraHold> {
  const claimed = await deps.queue.claim(culprit.queueId);
  if (!claimed) {
    const refreshed = await deps.queue.loadSnapshot(projectId);
    return { projectId, holdReason: "serialized", queueDepth, retryAfterMs: serializedRetryAfterMs(refreshed) };
  }
  await deps.events.emitAdvanced({ projectId, entry: culprit, queueDepth });

  const outcome = await driveOneEntry(deps, projectId, culprit);
  if (outcome.kind === "infra_hold" || outcome.kind === "infra_terminal") {
    return outcome;
  }
  if (outcome.kind === "merged") {
    await deps.queue.markMerged(culprit.queueId);
    return { projectId, queueDepth, mergedSpecId: culprit.specId };
  }
  const settled = await settleDriveOutcome(deps, projectId, culprit, outcome);
  if (settled !== "dequeued") {
    return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: settled.retryAfterMs };
  }
  return { projectId, queueDepth, dequeuedSpecId: culprit.specId };
}

/** Assign an owner to every failed fresh merge drive before the stale entry retires. */
export async function settleFailedDrive(
  deps: BatchSettleDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  failure: string,
): Promise<"dequeued" | "retained"> {
  const gateError = `merge drive failed fresh validation: ${failure}`;
  if (deps.gateRework === undefined) {
    const message = `${gateError}; no writer-rework router is configured`;
    const park = await deps.escalator.escalate({ projectId, entry: culprit, message });
    const settled = settleFromParkOutcome(park, message);
    if (settled.action === "retain") {
      await deps.queue.releaseClaim(culprit.queueId);
      return "retained";
    }
    if (!settled.alreadyDequeued) {
      await markDequeuedAfterEvent({
        queue: deps.queue,
        events: deps.events,
        projectId,
        entry: culprit,
        reason: settled.reason,
        message: settled.message,
        tx: deps.tx,
      });
    }
    return "dequeued";
  }
  const recovery = await deps.gateRework.routeGateFailToRework({ projectId, culprit, gateError });
  const settled = await settleWriterOwnedOrPark(
    deps,
    projectId,
    culprit,
    recovery,
    `${gateError}; handed to writer rework`,
    gateError,
  );
  if (settled.action === "retain") {
    await deps.queue.releaseClaim(culprit.queueId);
    return "retained";
  }
  if (!(settled.reason === "needs_attention" && settled.alreadyDequeued)) {
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry: culprit,
      reason: settled.reason,
      message: settled.message,
      tx: deps.tx,
    });
  }
  await deps.recoverableDriveHolds?.reset(culprit.queueId);
  return "dequeued";
}

async function driveOneEntry(
  deps: BatchBaseConflictDeps,
  projectId: string,
  entry: MergeQueueEntry,
): Promise<MergeDriveOutcome | BatchDriveInfraHold> {
  try {
    return await deps.runner.driveMerge({ runId: entry.runId, projectId });
  } catch (error) {
    const hold = await holdOnRetriableDriveThrow(deps, projectId, entry, error);
    if (hold !== undefined) return hold;
    return { kind: "blocked", message: `merge drive threw: ${String(error)}` };
  }
}
