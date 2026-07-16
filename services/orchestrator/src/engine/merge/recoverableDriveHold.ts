// Progress-bounded retry for recoverable native-queue drive outcomes. A returned
// `blocked` from the merge drive means "try this same candidate again later",
// not "remove this completed run from the queue forever". A returned `conflict`
// usually means the resolver has already routed an autonomous re-plan, so callers
// still let that candidate leave the old queue slot.
// This helper keeps that policy shared by the single-entry and batch
// coordinators: release the claim, back off, and once the SAME recoverable outcome
// is genuinely NOT recovering emit a loud infra-blocked alert with longer backoff so
// the queue neither hot-loops nor removes a retriable candidate permanently.
//
// no-timeouts reframe (feedback_no_timeouts_progress_based): the loud alert no longer
// fires on a fixed attempt COUNT — it fires on a PROGRESS signal. Each recoverable hold
// records the outcome's stable SIGNATURE; the alert fires only once that signature is
// SUSTAINED-non-recovering (the same outcome persisting with no progress across the
// backoff-spaced re-drives — the fixed-point read in `infraNonRecovery.ts`). A CHANGING
// outcome (a recovering / shifting block) keeps re-driving quietly. Behavior is otherwise
// unchanged: at the alert the candidate STAYS queued + re-drives on the longer backoff.
//
// Audit RC-7: the signature history (and the telemetry attempt count) is PERSISTED (a
// HoldCeilingStore) instead of a process-local Map, so a rolling deploy / crash-loop no
// longer forgets a flapping candidate's non-recovery streak. The `next`/`reset` API shape
// is unchanged (callers `await` it); the store is injected (an in-memory store keeps the
// in-process fakes Pg-free). The retry schedule + alert delay come from the single
// `retrySchedule.ts` source.

import type { MergeDriveOutcome, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";
import { isClassifiedMemberPolicyMessage } from "./authoritySignalClassification.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "./holdCeilingStore.js";
import { isSustainedInfraNonRecovery } from "./infraNonRecovery.js";
import { alertRetryAfterMs, recoverableRetryDelayMs } from "./retrySchedule.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge-coordinator");

/** The outcome of recording one recoverable hold: its telemetry attempt count, its
 * NON-RECOVERING verdict (the loud-alert trigger), and the backoff to space the next re-drive. */
export interface RecoverableHoldRecord {
  /** The persisted attempt count — TELEMETRY ONLY (the emitted `attempts` diagnostic), never the trigger. */
  attempts: number;
  /** The PROGRESS signal: the same recoverable outcome is sustained-non-recovering (alert + keep re-driving). */
  sustainedNonRecovery: boolean;
  /** The backoff before the next re-drive (recoverable curve below the alert; the longer delay at/after it). */
  retryAfterMs: number;
}

export class RecoverableDriveHoldCeiling {
  private readonly store: HoldCeilingStore;

  /**
   * The persisted signature history + telemetry count survive a restart (audit RC-7). Inject
   * the {@link PgHoldCeilingStore} in production; the default in-memory store keeps the
   * in-process fakes/unit tests Pg-free.
   */
  constructor(store?: HoldCeilingStore) {
    this.store = store ?? new InMemoryHoldCeilingStore();
  }

  /**
   * Record one recoverable hold for `queueId` under the outcome's stable `signature`. Returns
   * the NON-RECOVERY verdict (the alert trigger) keyed off whether that signature is now
   * sustained-non-recovering, the telemetry attempt count, and the next backoff. NOT a count
   * trigger: a CHANGING signature keeps re-driving on the recoverable curve no matter how many
   * holds precede it; only a persisting fixed-point signature alerts (then the longer backoff).
   */
  async next(queueId: string, signature: string): Promise<RecoverableHoldRecord> {
    // The telemetry count (observability only) and the durable signature history (the trigger).
    const attempts = await this.store.increment("recoverable_drive", queueId);
    const history = await this.store.recordSignature("recoverable_drive", queueId, signature);
    if (isSustainedInfraNonRecovery(history)) {
      // Clear the streak (like the prior cap-then-clear) so the alert is loud once-per-streak,
      // not re-spammed every pass; re-drive keeps going and only re-alerts on a fresh streak.
      await this.store.clear("recoverable_drive", queueId);
      return { attempts, sustainedNonRecovery: true, retryAfterMs: alertRetryAfterMs };
    }
    return { attempts, sustainedNonRecovery: false, retryAfterMs: recoverableRetryDelayMs(attempts) };
  }

  async reset(queueId: string): Promise<void> {
    await this.store.clear("recoverable_drive", queueId);
  }
}

/** The stable SIGNATURE of a recoverable drive outcome — its kind + message identity (so the
 * SAME block recurring is recognized across re-drives, and a DIFFERENT block reads as progress). */
export function recoverableOutcomeSignature(outcome: Extract<MergeDriveOutcome, { kind: "blocked" }>): string {
  return `${outcome.kind}:${outcome.message}`;
}

export type RecoverableDriveHoldResult = { kind: "held"; retryAfterMs: number };

export async function holdOrHaltRecoverableDrive(input: {
  ceiling: RecoverableDriveHoldCeiling;
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  outcome: Extract<MergeDriveOutcome, { kind: "blocked" }>;
}): Promise<RecoverableDriveHoldResult> {
  // mq-1: a classified member-policy block must never become merge.queue.infra_blocked.
  // The land path maps policy to `failed`; this is a fail-closed belt if a blocked slips through.
  if (isClassifiedMemberPolicyMessage(input.outcome.message)) {
    await input.ceiling.reset(input.entry.queueId);
    await input.queue.releaseClaim(input.entry.queueId);
    log.error("refusing infrastructure hold for classified member-policy authority block", {
      projectId: input.projectId,
      specId: input.entry.specId,
      message: input.outcome.message,
    });
    return { kind: "held", retryAfterMs: recoverableRetryDelayMs(1) };
  }

  const next = await input.ceiling.next(input.entry.queueId, recoverableOutcomeSignature(input.outcome));
  if (next.sustainedNonRecovery) {
    // The PROGRESS signal fired: the SAME recoverable outcome is sustained-non-recovering
    // (a persisting fixed point, not a count). Alert loudly, keep the entry queued, and
    // re-drive on the longer backoff — recovery stays autonomous, never abandoned.
    await input.events.emitInfraBlocked({
      projectId: input.projectId,
      entry: input.entry,
      kind: "ceiling",
      attempts: next.attempts,
      message: `${input.outcome.kind} merge drive outcome is not recovering (same failure across ${next.attempts} re-drives): ${input.outcome.message}`,
    });
    await input.queue.releaseClaim(input.entry.queueId);
    log.error("merge drive outcome not recovering (sustained); alerting and continuing autonomous re-drive", {
      projectId: input.projectId,
      specId: input.entry.specId,
      outcomeKind: input.outcome.kind,
      attempts: next.attempts,
      retryAfterMs: next.retryAfterMs,
    });
    return { kind: "held", retryAfterMs: next.retryAfterMs };
  }

  await input.queue.releaseClaim(input.entry.queueId);
  log.warn("merge drive returned a recoverable outcome; retrying same native-queue candidate", {
    projectId: input.projectId,
    specId: input.entry.specId,
    outcomeKind: input.outcome.kind,
    retryAfterMs: next.retryAfterMs,
    attempt: next.attempts,
  });
  return { kind: "held", retryAfterMs: next.retryAfterMs };
}
