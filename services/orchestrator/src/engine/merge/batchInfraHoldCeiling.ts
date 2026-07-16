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
// failure (a recovering / shifting outage) keeps re-driving quietly.
//
// v54 finding #56: on sustained-non-recovery `holdOnInfra` returns the ESCALATE verdict
// (`{ kind: "escalate" }`) rather than a longer-backoff hold. The caller (`infraHold` in
// `batchCoordinator.ts`) routes the batch back to the WRITER via `escalateInfraHoldToWriter`,
// identical in shape to the gate-fail-strand fix. A deterministic scaffold defect (e.g. a
// `just bootstrap` that fails in a fresh workspace) is no longer wedged in the queue
// forever; the writer iterates with the bootstrap failure as steering. The recoverable
// (signature-shifting) branch is unchanged.
//
// Audit RC-7: the signature history (and the telemetry hold count) is PERSISTED (a
// HoldCeilingStore) rather than a process-local Map. It survives across `coordinate` passes
// (each delayed re-drive is a fresh pass) AND across a rolling deploy / crash-loop — so a
// persistent outage cannot forget its non-recovery streak every restart and the terminal
// alert always fires. Reset on ANY non-infra-hold settle (a pass that merged / dequeued /
// pended) so a recovered batch starts fresh.

import type { CoordinateResult, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "./holdCeilingStore.js";
import { isSustainedInfraNonRecovery } from "./infraNonRecovery.js";
import { alertRetryAfterMs, recoverableRetryDelayMs } from "./retrySchedule.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** The in-pass retry budget already burned before a hold (for the emitted attempt count). */
const HELD_AFTER_ATTEMPTS = 3;
/**
 * Re-exported alert backoff constant. The batch-infra-hold path itself no longer uses this
 * (sustained-non-recovery now escalates to writer rework via `escalateInfraHoldToWriter`,
 * not a longer-backoff loop). Kept exported because the sibling real-merge-drive hold path
 * (`recoverableDriveHold.ts`) still uses the same alert backoff for its own sustained
 * non-recovery, and tests assert against this same identity.
 */
export const INFRA_HOLD_ALERT_RETRY_AFTER_MS = alertRetryAfterMs;

/**
 * The discriminated verdict `holdOnInfra` returns. `hold` is the signature-shifting
 * (recovering) branch the caller honors as-is. `escalate` is the sustained-non-recovery
 * (v54 #56) branch the caller routes through `escalateInfraHoldToWriter` for writer rework.
 */
export type HoldOnInfraVerdict = { kind: "hold"; result: CoordinateResult } | { kind: "escalate"; holds: number };

/**
 * GAP #1 (runaway guard): hold the batch on an infra error that could not recover
 * in-pass, guarded by SUSTAINED-NON-RECOVERY (a PROGRESS signal, not a count). Each
 * delayed re-drive is a fresh `coordinate` pass; without this guard a persistent outage
 * (or a permanent error mis-routed to the hold) re-drove the timer FOREVER. Records the
 * hold under the infra failure's stable SIGNATURE, then:
 *   - while the signature keeps SHIFTING (recovering) → emit a RECOVERABLE
 *     merge.batch.infra_blocked + return `{ kind: "hold" }` carrying the `infra_error`
 *     hold WITH `retryAfterMs` (the subscriber re-drives once more);
 *   - once the SAME signature is sustained-non-recovering → return `{ kind: "escalate" }`
 *     so the caller routes the batch to the WRITER via `escalateInfraHoldToWriter`
 *     (v54 #56). No terminal event is emitted here — the escalator owns the loud
 *     emission (with `disposition: "escalated_to_writer"`) and the dequeue cascade.
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
}): Promise<HoldOnInfraVerdict> {
  const { ceiling, events, projectId, batch, message, queueDepth } = args;
  const recorded = await ceiling.record(projectId, message);
  if (recorded.sustainedNonRecovery) {
    log.warn("batch check ESCALATING to writer rework on sustained merge-queue infra non-recovery", {
      projectId,
      consecutiveHolds: recorded.holds,
      message,
    });
    return { kind: "escalate", holds: recorded.holds };
  }
  await events.emitInfraBlocked({ projectId, batch, message, attempts: HELD_AFTER_ATTEMPTS });
  // apex-v35 VOLUME guard: back off the re-drive EXPONENTIALLY across consecutive holds
  // (3s → 10s → 30s → 60s) rather than a fixed ~3s hammer. A PERSISTENT upstream 403 (the
  // secondary-rate-limit case) is sustained by the re-drive volume itself, so a fixed-interval
  // re-check is a hot-loop that re-provokes the limit. Reusing the single-source recoverable
  // curve keeps every merge backoff consistent; the streak count drives the index.
  return {
    kind: "hold",
    result: {
      projectId,
      holdReason: "infra_error",
      retryAfterMs: recoverableRetryDelayMs(recorded.holds),
      queueDepth,
    },
  };
}

export async function terminalInfraBlock(args: {
  queue: MergeQueueModel;
  events: BatchMergeEventEmitter;
  escalator: SpecEscalator;
  projectId: string;
  batch: ReadonlyArray<MergeQueueEntry>;
  message: string;
  queueDepth: number;
  kind?: "missing_required_credential" | "ambiguous_merge_state";
}): Promise<CoordinateResult> {
  const event = {
    projectId: args.projectId,
    batch: args.batch,
    message: args.message,
    attempts: 1,
    terminal: true,
    consecutiveHolds: 1,
  };
  if (args.kind === undefined) {
    await args.events.emitInfraBlocked(event);
  } else {
    await args.events.emitInfraBlocked({ ...event, kind: args.kind });
  }

  if (args.kind === "missing_required_credential") {
    for (const entry of args.batch) await args.queue.releaseClaim(entry.queueId);
    return {
      projectId: args.projectId,
      holdReason: "infra_error",
      retryAfterMs: recoverableRetryDelayMs(1),
      queueDepth: args.queueDepth,
    };
  }

  let retryAfterMs: number | undefined;
  for (const entry of args.batch) {
    const parked = await args.escalator.escalate({ projectId: args.projectId, entry, message: args.message });
    if (parked.kind === "parking_failed") retryAfterMs = parked.retryAfterMs;
  }
  if (retryAfterMs !== undefined) {
    return { projectId: args.projectId, holdReason: "infra_error", retryAfterMs, queueDepth: args.queueDepth };
  }
  log.error("batch drive parked at needs_attention", { projectId: args.projectId, message: args.message });
  return { projectId: args.projectId, holdReason: "infra_blocked", queueDepth: args.queueDepth };
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
