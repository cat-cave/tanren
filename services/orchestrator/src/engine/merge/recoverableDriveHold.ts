// Bounded retry for recoverable native-queue drive outcomes. A returned
// `blocked` from the merge drive means "try this same candidate again later",
// not "remove this completed run from the queue forever". A returned `conflict`
// usually means the resolver has already routed an autonomous re-plan, so callers
// still let that candidate leave the old queue slot.
// This helper keeps that policy shared by the single-entry and batch
// coordinators: release the claim, back off, and after a ceiling emit a loud
// terminal infra-blocked halt so the queue never hot-loops indefinitely.

import type { MergeDriveOutcome, MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";

const RECOVERABLE_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];
const MAX_RECOVERABLE_DRIVE_ATTEMPTS = 5;

export class RecoverableDriveHoldCeiling {
  private readonly attempts = new Map<string, number>();

  next(queueId: string): { attempts: number; retryAfterMs?: number } {
    const attempts = (this.attempts.get(queueId) ?? 0) + 1;
    if (attempts >= MAX_RECOVERABLE_DRIVE_ATTEMPTS) {
      this.attempts.delete(queueId);
      return { attempts };
    }
    this.attempts.set(queueId, attempts);
    return {
      attempts,
      retryAfterMs: RECOVERABLE_RETRY_DELAYS_MS[Math.min(attempts - 1, RECOVERABLE_RETRY_DELAYS_MS.length - 1)],
    };
  }

  reset(queueId: string): void {
    this.attempts.delete(queueId);
  }
}

export type RecoverableDriveHoldResult =
  | { kind: "held"; retryAfterMs: number }
  | { kind: "terminal"; dequeuedSpecId: string };

export async function holdOrHaltRecoverableDrive(input: {
  ceiling: RecoverableDriveHoldCeiling;
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  outcome: Extract<MergeDriveOutcome, { kind: "blocked" }>;
}): Promise<RecoverableDriveHoldResult> {
  const next = input.ceiling.next(input.entry.queueId);
  if (next.retryAfterMs === undefined) {
    await input.events.emitInfraBlocked({
      projectId: input.projectId,
      entry: input.entry,
      kind: "ceiling",
      attempts: next.attempts,
      message: `${input.outcome.kind} merge drive outcome did not clear after ${next.attempts} retries: ${input.outcome.message}`,
    });
    await input.queue.markDequeued(input.entry.queueId, "blocked");
    return { kind: "terminal", dequeuedSpecId: input.entry.specId };
  }

  await input.queue.releaseClaim(input.entry.queueId);
  console.warn(
    `[merge-coordinator] project ${input.projectId}: merge drive for spec ${input.entry.specId} returned ${input.outcome.kind}; retrying same native-queue candidate after ${next.retryAfterMs}ms (attempt ${next.attempts}/${MAX_RECOVERABLE_DRIVE_ATTEMPTS})`,
  );
  return { kind: "held", retryAfterMs: next.retryAfterMs };
}
