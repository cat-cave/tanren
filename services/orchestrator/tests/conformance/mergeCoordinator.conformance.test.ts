// Drives the MergeCoordinator conformance suite against the REAL
// BatchMergeCoordinator wired to in-memory queue/runner/event fakes (TEST
// FIXTURES, tests/ only). Proves the production coordinator satisfies the §2d
// contract — DAG-order + priority + serialization + recoverable dequeue + liveness
// + idempotency — with no DB or VCS.

import { BatchMergeCoordinator } from "../../src/engine/merge/batchCoordinator.js";
import type { MergeDriveOutcome } from "../../src/engine/contracts/mergeCoordinator.js";
import type { SpecPriority } from "../../src/engine/state/spec.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./fakes/inMemoryBatchChecker.js";
import {
  describeMergeCoordinatorConformance,
  type MergeCoordinatorConformanceHarness,
} from "./mergeCoordinatorConformance.js";
import { allowExactBatchAuthority } from "../helpers/mq2BatchAuthority.js";

describeMergeCoordinatorConformance("BatchMergeCoordinator (in-memory)", {
  make(): MergeCoordinatorConformanceHarness {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const coordinator = new BatchMergeCoordinator({
      authorityEvaluator: allowExactBatchAuthority(),
      queue,
      runner,
      checker: new InMemoryBatchChecker(),
      events,
      batchEvents: new RecordingBatchMergeEventEmitter(),
      escalator,
      recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
      // Conformance suite asserts one-at-a-time selection; batch size 1 preserves that.
      resolveMaxBatchSize: async () => 1,
    });
    return {
      coordinator,
      projectId: "project_conf",
      seed(entry): void {
        queue.seed({
          runId: entry.runId,
          specId: entry.specId,
          dependsOn: entry.dependsOn,
          priority: (entry.priority ?? "tbd") as SpecPriority,
        });
      },
      seedLegacyDequeued(entry): void {
        queue.seedLegacyDequeued({
          runId: entry.runId,
          specId: entry.specId,
          reason: entry.reason,
          dependsOn: entry.dependsOn,
          priority: (entry.priority ?? "tbd") as SpecPriority,
        });
      },
      setMerged(specId: string): void {
        queue.markSpecMerged(specId);
      },
      scriptDrive(runId: string, outcome: MergeDriveOutcome): void {
        runner.script(runId, outcome);
      },
      statusOf(runId) {
        return queue.statusOf(runId);
      },
      drives: runner.drives,
      events: events.events,
      escalations: escalator.escalations,
    };
  },
});
