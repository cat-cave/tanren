import { describe, expect, it } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

const PROJECT = "project_batch";

function makeCoordinator() {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker: new InMemoryBatchChecker(),
    events: new RecordingMergeQueueEventEmitter(),
    batchEvents: new RecordingBatchMergeEventEmitter(),
    escalator: new RecordingSpecEscalator(),
    recoveryEvidence: new ScriptedRecoveryEvidencePort(),
    resolveMaxBatchSize: () => Promise.resolve(5),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner };
}

describe("BatchMergeCoordinator — serialized merge-claim recovery", () => {
  it("self-wakes after the claim lease and re-drives an abandoned serialized entry", async () => {
    const { coordinator, queue, runner } = makeCoordinator();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_spec_a", specId: "spec_a", dependsOn: [], priority: "tbd" });

    const snap = await queue.loadSnapshot(PROJECT);
    await queue.claim(snap.entries[0]!.queueId);

    const serialized = await coordinator.coordinate(PROJECT);

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_spec_a")).toBe("merging");

    now += serialized.retryAfterMs!;
    const recovered = await coordinator.coordinate(PROJECT);

    expect(recovered.mergedSpecId).toBe("spec_a");
    expect(queue.statusOf("run_spec_a")).toBe("merged");
    expect(runner.drives).toEqual([{ runId: "run_spec_a" }]);
  });

  it("self-wakes when another pass wins the merge claim race and then dies", async () => {
    const { coordinator, queue, runner } = makeCoordinator();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_spec_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const originalClaim = queue.claim.bind(queue);
    let claimAttempts = 0;
    queue.claim = async (queueId) => {
      claimAttempts += 1;
      if (claimAttempts === 1) {
        await originalClaim(queueId);
        return false;
      }
      return originalClaim(queueId);
    };

    const serialized = await coordinator.coordinate(PROJECT);

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_spec_a")).toBe("merging");

    now += serialized.retryAfterMs!;
    const recovered = await coordinator.coordinate(PROJECT);

    expect(recovered.mergedSpecId).toBe("spec_a");
    expect(queue.statusOf("run_spec_a")).toBe("merged");
    expect(runner.drives).toEqual([{ runId: "run_spec_a" }]);
  });
});
