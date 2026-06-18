// GAP #1 (merge hardening — runaway guard): the per-project CROSS-PASS infra-hold ALERT
// for the BatchMergeCoordinator. The batch coordinator already re-checks one batch IN-PASS
// while the infra error keeps shifting — but on a sustained-identical in-pass failure it
// HOLDS with a backoff re-drive and (before this) NO loud cross-pass signal. A PERSISTENT
// outage therefore re-drove FOREVER without surfacing operator-visible context. The alert
// emits a terminal `merge.batch.infra_blocked` event but keeps the entries active and backs
// off; a retriable infra outage must never turn into a permanent dequeued queue state.
//
// no-timeouts reframe (feedback_no_timeouts_progress_based): the terminal alert no longer
// fires on a fixed consecutive-hold COUNT — it fires on a PROGRESS signal. Each cross-pass
// hold records the infra failure's stable SIGNATURE; the alert fires only once that signature
// is SUSTAINED-non-recovering (the same failure persisting with no progress across the
// backoff-spaced re-drives — the fixed-point read in `infraNonRecovery.ts`). A CHANGING
// failure (a recovering / shifting outage) keeps re-driving quietly. Behavior is otherwise
// unchanged: at the alert the entries STAY queued + re-drive on the longer backoff.
//
// Audit RC-7: the signature history (and the telemetry hold count) is PERSISTED (a
// HoldCeilingStore) rather than a process-local Map. It survives across `coordinate` passes
// (each delayed re-drive is a fresh pass) AND across a rolling deploy / crash-loop — so a
// persistent outage cannot forget its non-recovery streak every restart and the terminal
// alert always fires. Reset on ANY non-infra-hold settle (a pass that merged / dequeued /
// pended) so a recovered batch starts fresh.

import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "./holdCeilingStore.js";
import { isSustainedInfraNonRecovery } from "./infraNonRecovery.js";
import { alertRetryAfterMs, recoverableRetryDelayMs } from "./retrySchedule.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** The in-pass retry budget already burned before a hold (for the emitted attempt count). */
const HELD_AFTER_ATTEMPTS = 3;
/** Longer re-drive delay after a terminal alert so persistent outages do not hot-loop. */
export const INFRA_HOLD_ALERT_RETRY_AFTER_MS = alertRetryAfterMs;

/**
 * GAP #1 (runaway guard): hold the batch on an infra error that could not recover
 * in-pass, guarded by SUSTAINED-NON-RECOVERY (a PROGRESS signal, not a count). Each
 * delayed re-drive is a fresh `coordinate` pass; without this guard a persistent outage
 * (or a permanent error mis-routed to the hold) re-drove the timer FOREVER. Records the
 * hold under the infra failure's stable SIGNATURE, then:
 *   - while the signature keeps SHIFTING (recovering) → emit a RECOVERABLE
 *     merge.batch.infra_blocked + return an `infra_error` hold WITH `retryAfterMs` (the
 *     subscriber re-drives once more);
 *   - once the SAME signature is sustained-non-recovering → emit a TERMINAL
 *     merge.batch.infra_blocked (`terminal: true`) but keep every affected entry queued +
 *     return an `infra_error` hold WITH a longer `retryAfterMs`. The alert is loud, but
 *     recovery remains autonomous.
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
  const recorded = await ceiling.record(projectId, message);
  if (recorded.sustainedNonRecovery) {
    await events.emitInfraBlocked({
      projectId,
      batch,
      message: `batch check infra error is not recovering (same failure across ${recorded.holds} re-drives); alerting and continuing autonomous re-drive: ${message}`,
      attempts: HELD_AFTER_ATTEMPTS,
      terminal: true,
      consecutiveHolds: recorded.holds,
    });
    log.error("batch check ALERT on sustained infra non-recovery; continuing autonomous re-drive after backoff", {
      projectId,
      consecutiveHolds: recorded.holds,
      message,
    });
    return { projectId, holdReason: "infra_error", retryAfterMs: INFRA_HOLD_ALERT_RETRY_AFTER_MS, queueDepth };
  }
  await events.emitInfraBlocked({ projectId, batch, message, attempts: HELD_AFTER_ATTEMPTS });
  // apex-v35 VOLUME guard: back off the re-drive EXPONENTIALLY across consecutive holds
  // (3s → 10s → 30s → 60s) rather than a fixed ~3s hammer. A PERSISTENT upstream 403 (the
  // secondary-rate-limit case) is sustained by the re-drive volume itself, so a fixed-interval
  // re-check is a hot-loop that re-provokes the limit. Reusing the single-source recoverable
  // curve keeps every merge backoff consistent; the streak count drives the index.
  return {
    projectId,
    holdReason: "infra_error",
    retryAfterMs: recoverableRetryDelayMs(recorded.holds),
    queueDepth,
  };
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
  log.error("batch drive HALTED; operator attention required", { projectId: args.projectId, message: args.message });
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

/**
 * The progress-guarded per-project infra-hold tracker (a runaway guard). Audit RC-7: the
 * signature history (+ telemetry hold count) is PERSISTED (a HoldCeilingStore) so it
 * survives a restart; inject the {@link PgHoldCeilingStore} in production, the default
 * in-memory store keeps the in-process fakes/unit tests Pg-free. The `record`/`reset` API
 * shape is unchanged (callers `await` it).
 */
export class BatchInfraHoldCeiling {
  private readonly store: HoldCeilingStore;

  constructor(store?: HoldCeilingStore) {
    this.store = store ?? new InMemoryHoldCeilingStore();
  }

  /**
   * Record one infra hold for a project under the failure's stable `signature` and report
   * whether it is SUSTAINED-NON-RECOVERING (a PROGRESS signal, not a count). Returns
   * `{ sustainedNonRecovery, holds }`: `sustainedNonRecovery === true` means the SAME
   * failure has persisted with no progress across the re-drives (a TERMINAL alert — the
   * caller emits the loud halt but keeps the entries queued + re-drives on the longer
   * backoff); otherwise (a still-shifting / recovering failure) the caller arms the
   * recoverable re-drive as before. `holds` is the persisted telemetry count, never the
   * trigger. On a sustained-non-recovery verdict the streak is CLEARED (like the prior
   * cap-then-clear) so the alert is loud once-per-streak, not re-spammed every pass — recovery
   * keeps re-driving and only re-alerts if non-recovery persists across a fresh streak.
   */
  async record(projectId: string, signature: string): Promise<{ sustainedNonRecovery: boolean; holds: number }> {
    const holds = await this.store.increment("batch_infra", projectId);
    const history = await this.store.recordSignature("batch_infra", projectId, signature);
    const sustainedNonRecovery = isSustainedInfraNonRecovery(history);
    if (sustainedNonRecovery) await this.store.clear("batch_infra", projectId);
    return { sustainedNonRecovery, holds };
  }

  /** Reset a project's streak — called on ANY settled (non-infra-hold) pass. */
  async reset(projectId: string): Promise<void> {
    await this.store.clear("batch_infra", projectId);
  }
}
