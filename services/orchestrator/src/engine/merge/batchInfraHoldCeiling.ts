// GAP #1 (merge hardening — runaway guard): the per-project CROSS-PASS consecutive
// infra-hold ALERT threshold for the BatchMergeCoordinator. The batch coordinator already
// bounds the IN-PASS re-checks of one batch (`MAX_INFRA_RETRIES`) — but on exhaustion
// it HOLDS with a 3s `INFRA_HOLD_RETRY_AFTER_MS` re-drive and (before this) NO loud
// cross-pass signal. A PERSISTENT outage therefore re-drove every 3s FOREVER without
// surfacing operator-visible context. The alert threshold emits a terminal
// `merge.batch.infra_blocked` event but keeps the entries active and backs off; a
// retriable infra outage must never turn into a permanent dequeued queue state.
//
// It is an in-memory per-project counter by design — the coordinator+subscriber are a
// single long-lived per-worker singleton, so the count survives across `coordinate`
// passes (each delayed re-drive is a fresh pass). A crash resets it, which is correct:
// `recoverStaleClaims` re-queues + a re-driven idempotent merge is safe, and a still-
// broken infra re-accrues holds to the ceiling again. Reset on ANY non-infra-hold
// settle (a pass that merged / dequeued / pended) so a recovered batch starts fresh.

/**
 * How many CONSECUTIVE cross-pass infra holds one project's batch may take before the
 * coordinator emits a TERMINAL loud alert. The entries remain queued and the subscriber
 * still receives a delayed re-drive, just with a longer backoff after the alert. The
 * common case (a GitHub blip) clears in 1–2 holds, well under this.
 */
export const MAX_BATCH_INFRA_HOLDS = 5;

import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";

/** The in-pass retry budget already burned before a hold (for the emitted attempt count). */
const HELD_AFTER_ATTEMPTS = 3;
/** How long after a RECOVERABLE infra hold the subscriber re-drives the project. */
const INFRA_HOLD_RETRY_AFTER_MS = 3000;
/** Longer re-drive delay after a terminal alert so persistent outages do not hot-loop. */
export const INFRA_HOLD_ALERT_RETRY_AFTER_MS = 60_000;

/**
 * GAP #1 (runaway guard): hold the batch on an infra error that could not recover
 * in-pass, BOUNDED by the per-project CROSS-PASS consecutive-infra-hold ceiling. Each
 * delayed re-drive is a fresh `coordinate` pass; without this counter a persistent
 * outage (or a permanent error mis-routed to the hold) re-drove the 3s timer FOREVER.
 * Records the hold, then:
 *   - below the cap → emit a RECOVERABLE merge.batch.infra_blocked + return an
 *     `infra_error` hold WITH `retryAfterMs` (the subscriber re-drives once more);
 *   - at the cap → emit a TERMINAL merge.batch.infra_blocked (`terminal: true`) but
 *     keep every affected entry queued + return an `infra_error` hold WITH a longer
 *     `retryAfterMs`. The alert is loud, but recovery remains autonomous.
 */
export async function holdOnInfra(args: {
  ceiling: BatchInfraHoldCeiling;
  queue: MergeQueueModel;
  events: BatchMergeEventEmitter;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  queueDepth: number;
  kind?: "missing_required_credential";
}): Promise<CoordinateResult> {
  const { ceiling, events, projectId, batch, message, queueDepth } = args;
  const recorded = ceiling.record(projectId);
  if (recorded.reached) {
    await events.emitInfraBlocked({
      projectId,
      batch,
      message: `batch check kept hitting an infra error across ${recorded.holds} consecutive holds; alerting and continuing autonomous re-drive: ${message}`,
      attempts: HELD_AFTER_ATTEMPTS,
      terminal: true,
      consecutiveHolds: recorded.holds,
    });
    console.error(
      `[batch-coordinator] project ${projectId}: batch check ALERT after ${recorded.holds} consecutive infra holds; continuing autonomous re-drive after backoff: ${message}`,
    );
    return { projectId, holdReason: "infra_error", retryAfterMs: INFRA_HOLD_ALERT_RETRY_AFTER_MS, queueDepth };
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
  kind?: "missing_required_credential" | "ambiguous_merge_state";
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
  kind?: "missing_required_credential" | "ambiguous_merge_state";
}): Promise<void> {
  const event = {
    projectId: input.projectId,
    batch: input.batch,
    message: input.message,
    attempts: input.attempts,
    terminal: input.terminal,
    consecutiveHolds: input.consecutiveHolds,
  };
  if (input.kind === undefined) {
    await input.events.emitInfraBlocked(event);
  } else {
    await input.events.emitInfraBlocked({ ...event, kind: input.kind });
  }
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
