import { describe, expect, it } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";

describe("BatchMergeCoordinator merge-truth reconciliation", () => {
  it("runs merge-truth repair before forming the DAG snapshot", async () => {
    const queue = new InMemoryMergeQueueModel();
    queue.seed({ runId: "run_child", specId: "spec_child", dependsOn: ["spec_parent"], priority: "tbd" });
    queue.markSpecMerged("spec_parent");
    const runner = new ScriptedMergeRunner();
    const coordinator = new BatchMergeCoordinator({
      queue,
      runner,
      checker: new InMemoryBatchChecker(),
      events: new RecordingMergeQueueEventEmitter(),
      batchEvents: new RecordingBatchMergeEventEmitter(),
      escalator: new RecordingSpecEscalator(),
      mergeTruth: { reconcile: async () => queue.unmarkSpecMerged("spec_parent") },
    });

    const result = await coordinator.coordinate("project_apex");

    expect(result.holdReason).toBe("all_blocked");
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_child")).toBe("queued");
  });
});
