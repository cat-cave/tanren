import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { allowExactBatchAuthority } from "./helpers/mq2BatchAuthority.js";

describe("mq-8 production coordinator insertion point", () => {
  it("runs EAGER plan/build after stale-claim recovery and before the fresh queue snapshot", async () => {
    const order: string[] = [];
    const queue = new InMemoryMergeQueueModel();
    vi.spyOn(queue, "recoverStaleClaims").mockImplementation(async () => {
      order.push("recover");
    });
    vi.spyOn(queue, "loadSnapshot").mockImplementation(async (projectId) => {
      order.push("snapshot");
      return { projectId, entries: [], mergedSpecIds: new Set<string>(), mergingInFlight: false };
    });
    const events = new RecordingMergeQueueEventEmitter();
    const coordinator = new BatchMergeCoordinator({
      queue,
      runner: new ScriptedMergeRunner(),
      checker: new InMemoryBatchChecker(),
      authorityEvaluator: allowExactBatchAuthority(),
      events,
      batchEvents: new RecordingBatchMergeEventEmitter(),
      escalator: new RecordingSpecEscalator(),
      recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
      eagerBeamPlanner: { planAndBuild: async () => order.push("eager") },
    });

    await coordinator.coordinate("project_eager");

    expect(order).toEqual(["recover", "eager", "snapshot"]);
  });
});
