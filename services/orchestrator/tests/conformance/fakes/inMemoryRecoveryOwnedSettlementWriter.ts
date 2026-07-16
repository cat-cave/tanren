import type {
  RecoveryOwnedSettleInput,
  RecoveryOwnedSettleOutcome,
  RecoveryOwnedSettlementWriter,
} from "../../../src/engine/contracts/runStateWriter.js";
import type { InMemoryMergeQueueModel, RecordingMergeQueueEventEmitter } from "./inMemoryMergeQueue.js";

/** In-memory model of the atomic owned-recovery success authority. */
export class InMemoryRecoveryOwnedSettlementWriter implements RecoveryOwnedSettlementWriter {
  constructor(
    private readonly queue: InMemoryMergeQueueModel,
    private readonly events: RecordingMergeQueueEventEmitter,
    private readonly mode: "accept" | "reject" = "accept",
  ) {}

  async settleOwnedRecoveryAndDequeue(input: RecoveryOwnedSettleInput): Promise<RecoveryOwnedSettleOutcome> {
    const entry = this.queue.entryForQueueId(input.projectId, input.queueId);
    if (entry === undefined || entry.runId !== input.runId || entry.specId !== input.specId) {
      return {
        kind: "settlement_failed",
        reason: "ownership_missing",
        queueDisposition: "unknown",
        retryAfterMs: 3000,
      };
    }
    if (entry.status === "dequeued" && this.queue.dequeueReasonOf(input.runId) === input.reason) {
      return { kind: "settled", newlySettled: false };
    }
    if (entry.status !== "queued" && entry.status !== "merging") {
      return { kind: "settlement_failed", reason: "queue_not_active", queueDisposition: "unknown", retryAfterMs: 3000 };
    }
    const run = input.receipt.run;
    const structurallyValid =
      input.receipt.specId === input.specId &&
      (run.kind === "enqueued"
        ? run.replanRunId.trim() !== "" && run.plannerTaskId.trim() !== ""
        : run.runId.trim() !== "");
    if (this.mode === "reject" || !structurallyValid) {
      return {
        kind: "settlement_failed",
        reason: "evidence_invalid",
        queueDisposition: "retained",
        retryAfterMs: 3000,
      };
    }
    await this.events.emitDequeued({
      projectId: input.projectId,
      entry,
      reason: input.reason,
      message: input.message,
    });
    await this.queue.markDequeued(input.queueId, input.reason);
    return { kind: "settled", newlySettled: true };
  }
}
