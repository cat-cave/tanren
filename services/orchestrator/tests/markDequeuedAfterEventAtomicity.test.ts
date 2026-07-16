// Ordinary terminal settlement has one writer-plane-independent ordering.

import { describe, expect, it } from "vitest";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { markDequeuedAfterEvent } from "../src/engine/merge/coordinator.js";
import { InMemoryMergeQueueModel, RecordingMergeQueueEventEmitter } from "./conformance/fakes/inMemoryMergeQueue.js";

const PROJECT = "project_atomicity";

async function seededEntry(queue: InMemoryMergeQueueModel, runId: string, specId: string): Promise<MergeQueueEntry> {
  queue.seed({ runId, specId, dependsOn: [], priority: "tbd" });
  const snapshot = await queue.loadSnapshot(PROJECT);
  const entry = snapshot.entries.find((e) => e.runId === runId);
  if (entry === undefined) throw new Error("seeded entry not found");
  return entry;
}

describe("markDequeuedAfterEvent ordering", () => {
  it("uses the same event-first order when the queue update fails", async () => {
    const queue = new InMemoryMergeQueueModel();
    const events = new RecordingMergeQueueEventEmitter();
    const entry = await seededEntry(queue, "run_split_tx", "spec_split_tx");
    expect(await queue.claim(entry.queueId)).toBe(true);
    expect(queue.statusOf("run_split_tx")).toBe("merging");

    const failingQueue = {
      ...queue,
      markDequeued: () => Promise.reject(new Error("queue update failed")),
    } as unknown as InMemoryMergeQueueModel;

    await expect(
      markDequeuedAfterEvent({
        queue: failingQueue,
        events,
        projectId: PROJECT,
        entry,
        reason: "failed",
        message: "terminal merge failure",
      }),
    ).rejects.toThrow("queue update failed");

    expect(events.events.filter((e) => e.type === "merge.dequeued")).toHaveLength(1);
    expect(queue.statusOf("run_split_tx")).toBe("merging");
  });

  it("emits then retires on a clean settle", async () => {
    const queue = new InMemoryMergeQueueModel();
    const events = new RecordingMergeQueueEventEmitter();
    const entry = await seededEntry(queue, "run_ok_tx", "spec_ok_tx");
    expect(await queue.claim(entry.queueId)).toBe(true);

    await markDequeuedAfterEvent({
      queue,
      events,
      projectId: PROJECT,
      entry,
      reason: "failed",
      message: "terminal merge failure",
    });

    const dequeued = events.events.filter((e) => e.type === "merge.dequeued");
    expect(dequeued).toHaveLength(1);
    expect(dequeued[0]?.specId).toBe("spec_ok_tx");
    expect(queue.statusOf("run_ok_tx")).toBe("dequeued");
    expect(queue.dequeueReasonOf("run_ok_tx")).toBe("failed");
  });
});
