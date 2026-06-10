// Bounded retry for recoverable native-queue drive outcomes. A returned
// `blocked` from the merge drive means "try this same candidate again later",
// not "remove this completed run from the queue forever". A returned `conflict`
// usually means the resolver has already routed an autonomous re-plan, so callers
// still let that candidate leave the old queue slot.
// This helper keeps that policy shared by the single-entry and batch
// coordinators: release the claim, back off, and after a ceiling emit a loud
// infra-blocked alert with longer backoff so the queue neither hot-loops nor
// removes a retriable candidate permanently.
//
// Audit RC-7: the per-entry attempt counter is now PERSISTED (a HoldCeilingStore)
// instead of a process-local Map, so a rolling deploy / crash-loop no longer re-grants
// a flapping candidate its full attempt budget. The `next`/`reset` API shape is
// unchanged (callers `await` it); the store is injected (an in-memory store keeps the
// in-process fakes Pg-free). The retry schedule + alert delay come from the single
// `retrySchedule.ts` source.

import type { MergeDriveOutcome, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";
import { type HoldCeilingStore, InMemoryHoldCeilingStore } from "./holdCeilingStore.js";
import { alertRetryAfterMs, recoverableRetryDelayMs } from "./retrySchedule.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge-coordinator");

const MAX_RECOVERABLE_DRIVE_ATTEMPTS = 5;

export class RecoverableDriveHoldCeiling {
  private readonly store: HoldCeilingStore;

  /**
   * The persisted counter survives a restart (audit RC-7). Inject the {@link PgHoldCeilingStore}
   * in production; the default in-memory store keeps the in-process fakes/unit tests Pg-free.
   */
  constructor(store?: HoldCeilingStore) {
    this.store = store ?? new InMemoryHoldCeilingStore();
  }

  async next(queueId: string): Promise<{ attempts: number; retryAfterMs?: number }> {
    const attempts = await this.store.increment("recoverable_drive", queueId);
    if (attempts >= MAX_RECOVERABLE_DRIVE_ATTEMPTS) {
      await this.store.clear("recoverable_drive", queueId);
      return { attempts };
    }
    return { attempts, retryAfterMs: recoverableRetryDelayMs(attempts) };
  }

  async reset(queueId: string): Promise<void> {
    await this.store.clear("recoverable_drive", queueId);
  }
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
  const next = await input.ceiling.next(input.entry.queueId);
  if (next.retryAfterMs === undefined) {
    await input.events.emitInfraBlocked({
      projectId: input.projectId,
      entry: input.entry,
      kind: "ceiling",
      attempts: next.attempts,
      message: `${input.outcome.kind} merge drive outcome did not clear after ${next.attempts} retries: ${input.outcome.message}`,
    });
    await input.queue.releaseClaim(input.entry.queueId);
    log.error("merge drive outcome did not clear after retries; alerting and continuing autonomous re-drive", {
      projectId: input.projectId,
      specId: input.entry.specId,
      outcomeKind: input.outcome.kind,
      attempts: next.attempts,
      retryAfterMs: alertRetryAfterMs,
    });
    return { kind: "held", retryAfterMs: alertRetryAfterMs };
  }

  await input.queue.releaseClaim(input.entry.queueId);
  log.warn("merge drive returned a recoverable outcome; retrying same native-queue candidate", {
    projectId: input.projectId,
    specId: input.entry.specId,
    outcomeKind: input.outcome.kind,
    retryAfterMs: next.retryAfterMs,
    attempt: next.attempts,
    maxAttempts: MAX_RECOVERABLE_DRIVE_ATTEMPTS,
  });
  return { kind: "held", retryAfterMs: next.retryAfterMs };
}
