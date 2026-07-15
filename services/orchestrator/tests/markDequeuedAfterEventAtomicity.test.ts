// markDequeuedAfterEvent atomicity (audit RC-4 #3): both-commit-or-both-roll-back.
// Rehomed from the deleted EventEmittingMergeCoordinator suite — still live under
// the batch settle path (FakeMergeSettleTransaction models both-or-neither).

import { describe, expect, it } from "vitest";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { markDequeuedAfterEvent } from "../src/engine/merge/coordinator.js";
import {
  FakeMergeSettleTransaction,
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
} from "./conformance/fakes/inMemoryMergeQueue.js";

const PROJECT = "project_atomicity";

async function seededEntry(queue: InMemoryMergeQueueModel, runId: string, specId: string): Promise<MergeQueueEntry> {
  queue.seed({ runId, specId, dependsOn: [], priority: "tbd" });
  const snapshot = await queue.loadSnapshot(PROJECT);
  const entry = snapshot.entries.find((e) => e.runId === runId);
  if (entry === undefined) throw new Error("seeded entry not found");
  return entry;
}

describe("markDequeuedAfterEvent atomicity (audit RC-4 #3)", () => {
  it("when the queue UPDATE throws inside the settle transaction, the event is NOT durably applied", async () => {
    const queue = new InMemoryMergeQueueModel();
    const events = new RecordingMergeQueueEventEmitter();
    const entry = await seededEntry(queue, "run_split_tx", "spec_split_tx");
    expect(await queue.claim(entry.queueId)).toBe(true);
    expect(queue.statusOf("run_split_tx")).toBe("merging");

    const tx = new FakeMergeSettleTransaction(events, queue, new Error("queue update failed mid-transaction"));

    await expect(
      markDequeuedAfterEvent({
        queue,
        events,
        projectId: PROJECT,
        entry,
        reason: "failed",
        message: "terminal merge failure",
        tx,
      }),
    ).rejects.toThrow("queue update failed mid-transaction");

    expect(events.events.filter((e) => e.type === "merge.dequeued")).toEqual([]);
    expect(queue.statusOf("run_split_tx")).toBe("merging");
  });

  it("on a clean settle transaction, BOTH the event AND the row dequeue commit together", async () => {
    const queue = new InMemoryMergeQueueModel();
    const events = new RecordingMergeQueueEventEmitter();
    const entry = await seededEntry(queue, "run_ok_tx", "spec_ok_tx");
    expect(await queue.claim(entry.queueId)).toBe(true);

    const tx = new FakeMergeSettleTransaction(events, queue);
    await markDequeuedAfterEvent({
      queue,
      events,
      projectId: PROJECT,
      entry,
      reason: "failed",
      message: "terminal merge failure",
      tx,
    });

    const dequeued = events.events.filter((e) => e.type === "merge.dequeued");
    expect(dequeued).toHaveLength(1);
    expect(dequeued[0]?.specId).toBe("spec_ok_tx");
    expect(queue.statusOf("run_ok_tx")).toBe("dequeued");
    expect(queue.dequeueReasonOf("run_ok_tx")).toBe("failed");
  });
});
