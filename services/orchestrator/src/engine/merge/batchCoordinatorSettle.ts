// The non-merged drive-outcome SETTLE mapping for the P2d-2 BatchMergeCoordinator,
// split from `batchCoordinator.ts` to keep that file under the 500-line cap. It is the
// SAME settle policy the P2d-1 EventEmittingMergeCoordinator applies, so the two
// coordinators can never diverge on how a real-merge outcome leaves the queue:
//   - `needs_attention` → the NON-BRICKING conflict escalation (§2c): PARK the spec at
//     `needs_attention` (frees its slot) via the shared `SpecEscalator`, then dequeue
//     the entry `needs_attention` (NEVER re-queued). NOT the recoverable conflict path.
//   - `conflict` / `blocked` / `failed` → the recoverable/terminal dequeue: the entry
//     leaves the ready set + emits `merge.dequeued` with the reason.
//
// `merged` is handled inline by the caller (it advances rather than settling out), so
// this maps only the NON-merged outcomes.

import type { MergeDriveOutcome, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";

/** The slice of the batch coordinator's deps the settle mapping needs. */
export interface BatchSettleDeps {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  escalator: SpecEscalator;
}

/**
 * Settle a NON-merged real-merge outcome for one batch entry. A `needs_attention`
 * outcome parks the spec (frees its slot) + dequeues `needs_attention`; any other
 * outcome (`conflict`/`blocked`/`failed`) is a recoverable/terminal dequeue with that
 * reason. Mirrors `EventEmittingMergeCoordinator.driveAndSettle` exactly.
 */
export async function settleDriveOutcome(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  outcome: Exclude<MergeDriveOutcome, { kind: "merged" }>,
): Promise<void> {
  if (outcome.kind === "needs_attention") {
    // The LOUD TERMINAL ESCALATION (§2c — non-bricking): park the spec FIRST (frees its
    // slot — the rest of the DAG keeps moving), then dequeue `needs_attention` (NEVER
    // re-queued). The escalator emits `dag.spec.needs_attention`; the dequeue emits
    // `merge.dequeued`. NOT the recoverable conflict path (it would re-conflict forever).
    await deps.escalator.escalate({ projectId, entry, message: outcome.message });
    await deps.queue.markDequeued(entry.queueId, "needs_attention");
    await deps.events.emitDequeued({ projectId, entry, reason: "needs_attention", message: outcome.message });
    return;
  }

  const reason = outcome.kind;
  await deps.queue.markDequeued(entry.queueId, reason);
  await deps.events.emitDequeued({ projectId, entry, reason, message: outcome.message });
}
