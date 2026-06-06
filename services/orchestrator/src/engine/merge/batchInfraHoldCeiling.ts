// GAP #1 (merge hardening — runaway guard): the per-project CROSS-PASS consecutive
// infra-hold CEILING for the BatchMergeCoordinator. The batch coordinator already
// bounds the IN-PASS re-checks of one batch (`MAX_INFRA_RETRIES`) — but on exhaustion
// it HOLDS with a 3s `INFRA_HOLD_RETRY_AFTER_MS` re-drive and (before this) NO
// cross-pass counter. A PERSISTENT outage (or a permanent error mis-routed to the
// hold) therefore re-drove every 3s FOREVER, never surfacing a terminal halt. This
// mirrors the per-PR EventEmittingMergeCoordinator's `MAX_INFRA_HOLD_ATTEMPTS`.
//
// It is an in-memory per-project counter by design — the coordinator+subscriber are a
// single long-lived per-worker singleton, so the count survives across `coordinate`
// passes (each delayed re-drive is a fresh pass). A crash resets it, which is correct:
// `recoverStaleClaims` re-queues + a re-driven idempotent merge is safe, and a still-
// broken infra re-accrues holds to the ceiling again. Reset on ANY non-infra-hold
// settle (a pass that merged / dequeued / pended) so a recovered batch starts fresh.

/**
 * How many CONSECUTIVE cross-pass infra holds one project's batch may take before the
 * coordinator stops re-arming the re-drive timer and escalates to a TERMINAL loud halt.
 * Bounds the recover-on-infra loop so a persistent outage surfaces loudly. The common
 * case (a GitHub blip) clears in 1–2 holds, well under this. Mirrors
 * `MAX_INFRA_HOLD_ATTEMPTS` on the per-PR coordinator.
 */
export const MAX_BATCH_INFRA_HOLDS = 5;

import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";

/** The in-pass retry budget already burned before a hold (for the emitted attempt count). */
const HELD_AFTER_ATTEMPTS = 3;
/** How long after a RECOVERABLE infra hold the subscriber re-drives the project. */
const INFRA_HOLD_RETRY_AFTER_MS = 3000;

/**
 * GAP #1 (runaway guard): hold the batch on an infra error that could not recover
 * in-pass, BOUNDED by the per-project CROSS-PASS consecutive-infra-hold ceiling. Each
 * delayed re-drive is a fresh `coordinate` pass; without this counter a persistent
 * outage (or a permanent error mis-routed to the hold) re-drove the 3s timer FOREVER.
 * Records the hold, then:
 *   - below the cap → emit a RECOVERABLE merge.batch.infra_blocked + return an
 *     `infra_error` hold WITH `retryAfterMs` (the subscriber re-drives once more);
 *   - at the cap → emit a TERMINAL merge.batch.infra_blocked (`terminal: true`) + return
 *     an `infra_blocked` halt with NO `retryAfterMs`, so the subscriber arms NO further
 *     timer — a loud operator-visible STOP. The terminal event is appended first, then
 *     affected entries leave the active queue as `blocked`, mirroring the per-PR
 *     coordinator's event-before-dequeue split-brain guard.
 */
export async function holdOnInfra(args: {
  ceiling: BatchInfraHoldCeiling;
  queue: MergeQueueModel;
  events: BatchMergeEventEmitter;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  queueDepth: number;
}): Promise<CoordinateResult> {
  const { ceiling, queue, events, projectId, batch, message, queueDepth } = args;
  const recorded = ceiling.record(projectId);
  if (recorded.reached) {
    await markBatchInfraBlockedAfterEvent({
      queue,
      events,
      projectId,
      batch,
      message: `batch check kept hitting an infra error across ${recorded.holds} consecutive holds; halting (operator attention required): ${message}`,
      attempts: HELD_AFTER_ATTEMPTS,
      terminal: true,
      consecutiveHolds: recorded.holds,
    });
    console.error(
      `[batch-coordinator] project ${projectId}: batch check HALTED after ${recorded.holds} consecutive infra holds; operator attention required: ${message}`,
    );
    // Terminal: NO retryAfterMs ⇒ the subscriber arms no further timer (no re-drive loop).
    return { projectId, holdReason: "infra_blocked", queueDepth };
  }
  await events.emitInfraBlocked({ projectId, batch, message, attempts: HELD_AFTER_ATTEMPTS });
  return { projectId, holdReason: "infra_error", retryAfterMs: INFRA_HOLD_RETRY_AFTER_MS, queueDepth };
}

export async function terminalInfraBlock(args: {
  queue: MergeQueueModel;
  events: BatchMergeEventEmitter;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  queueDepth: number;
}): Promise<CoordinateResult> {
  await markBatchInfraBlockedAfterEvent({ ...args, attempts: 1, terminal: true, consecutiveHolds: 1 });
  console.error(
    `[batch-coordinator] project ${args.projectId}: batch drive HALTED; operator attention required: ${args.message}`,
  );
  return { projectId: args.projectId, holdReason: "infra_blocked", queueDepth: args.queueDepth };
}

async function markBatchInfraBlockedAfterEvent(input: {
  queue: MergeQueueModel;
  events: BatchMergeEventEmitter;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  attempts: number;
  terminal: true;
  consecutiveHolds: number;
}): Promise<void> {
  await input.events.emitInfraBlocked({
    projectId: input.projectId,
    batch: input.batch,
    message: input.message,
    attempts: input.attempts,
    terminal: input.terminal,
    consecutiveHolds: input.consecutiveHolds,
  });
  for (const entry of input.batch) {
    await input.queue.markDequeued(entry.queueId, "blocked");
  }
}

/** The bounded per-project consecutive-infra-hold counter (a runaway guard). */
export class BatchInfraHoldCeiling {
  private readonly holds = new Map<string, number>();

  constructor(private readonly cap: number = MAX_BATCH_INFRA_HOLDS) {}

  /**
   * Record one infra hold for a project and report whether the CEILING is now reached.
   * Returns `{ reached, holds }`: `reached === true` means this hold hit the cap (a
   * TERMINAL escalation — the caller emits the loud halt + arms NO further timer);
   * otherwise the caller arms the bounded re-drive as before.
   */
  record(projectId: string): { reached: boolean; holds: number } {
    const next = (this.holds.get(projectId) ?? 0) + 1;
    this.holds.set(projectId, next);
    if (next >= this.cap) {
      // The ceiling fired: clear the streak so a later recovered batch starts fresh.
      this.holds.delete(projectId);
      return { reached: true, holds: next };
    }
    return { reached: false, holds: next };
  }

  /** Reset a project's streak — called on ANY settled (non-infra-hold) pass. */
  reset(projectId: string): void {
    this.holds.delete(projectId);
  }
}
