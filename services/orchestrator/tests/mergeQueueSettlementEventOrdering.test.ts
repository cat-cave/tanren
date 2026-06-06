import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";

const PROJECT = "project_settlement_ordering";

function makeBatchHarness(): {
  coordinator: BatchMergeCoordinator;
  queue: InMemoryMergeQueueModel;
  checker: InMemoryBatchChecker;
  events: RecordingMergeQueueEventEmitter;
} {
  const queue = new InMemoryMergeQueueModel();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner: new ScriptedMergeRunner(),
    checker,
    events,
    batchEvents: new RecordingBatchMergeEventEmitter(),
    escalator: new RecordingSpecEscalator(),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, checker, events };
}

describe("merge queue settlement/event ordering", () => {
  it("keeps a bisected culprit queued when merge.dequeued append fails before settlement", async () => {
    const h = makeBatchHarness();
    h.queue.seed({ runId: "run_spec_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    h.queue.seed({ runId: "run_spec_b", specId: "spec_b", dependsOn: [], priority: "tbd" });
    h.checker.failWhenContains("spec_b");
    vi.spyOn(h.events, "emitDequeued").mockRejectedValueOnce(new Error("event store unavailable"));

    await expect(h.coordinator.coordinate(PROJECT)).rejects.toThrow("event store unavailable");

    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
  });
});
