import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { MergeAmbiguousError } from "../src/engine/providers/mergeOutcomeErrors.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { allowExactBatchAuthority } from "./helpers/mq2BatchAuthority.js";

function makeHarness() {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const coordinator = new BatchMergeCoordinator({
    authorityEvaluator: allowExactBatchAuthority(),
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator: new RecordingSpecEscalator(queue),
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents };
}

describe("BatchMergeCoordinator — ambiguous drive throw", () => {
  it("terminally infra-blocks a passing-batch drive ambiguity without recoverable dequeue", async () => {
    const h = makeHarness();
    h.queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    let drives = 0;
    h.runner.driveMerge = async () => {
      drives += 1;
      throw new MergeAmbiguousError("merge PUT 504 and state could not be confirmed");
    };

    const result = await h.coordinator.coordinate("project_batch");
    const second = await h.coordinator.coordinate("project_batch");

    expect(result.holdReason).toBe("infra_blocked");
    expect(result.retryAfterMs).toBeUndefined();
    expect(second.holdReason).toBe("empty");
    expect(h.queue.statusOf("run_a")).toBe("dequeued");
    expect(drives).toBe(1);
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    expect(h.batchEvents.events).toContainEqual(
      expect.objectContaining({
        type: "infra_blocked",
        specIds: ["spec_a"],
        terminal: true,
        consecutiveHolds: 1,
        kind: "ambiguous_merge_state",
      }),
    );
  });

  it("attributes a multi-entry passing-batch ambiguity to the actual ambiguous entry", async () => {
    const h = makeHarness();
    h.queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    h.queue.seed({ runId: "run_b", specId: "spec_b", dependsOn: [], priority: "tbd" });
    const drives: string[] = [];
    h.runner.driveMerge = async ({ runId }) => {
      drives.push(runId);
      if (runId === "run_b") throw new MergeAmbiguousError("second merge state unconfirmable");
      return { kind: "merged", mergeSha: `sha_${runId}` };
    };

    const result = await h.coordinator.coordinate("project_batch");
    const second = await h.coordinator.coordinate("project_batch");

    expect(result.holdReason).toBe("infra_blocked");
    expect(second.holdReason).toBe("empty");
    expect(h.queue.statusOf("run_a")).toBe("merged");
    expect(h.queue.statusOf("run_b")).toBe("dequeued");
    expect(drives).toEqual(["run_a", "run_b"]);
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    expect(h.batchEvents.events).toContainEqual(
      expect.objectContaining({
        type: "infra_blocked",
        specIds: ["spec_b"],
        terminal: true,
        consecutiveHolds: 1,
        kind: "ambiguous_merge_state",
      }),
    );
  });

  it("terminally infra-blocks a base-conflict drive ambiguity without recoverable dequeue", async () => {
    const h = makeHarness();
    h.queue.seed({ runId: "run_b", specId: "spec_b", dependsOn: [], priority: "tbd" });
    h.checker.baseConflictWhenContains("spec_b");
    let drives = 0;
    h.runner.driveMerge = async () => {
      drives += 1;
      throw new MergeAmbiguousError("resolver merge state unconfirmable");
    };

    const result = await h.coordinator.coordinate("project_batch");
    const second = await h.coordinator.coordinate("project_batch");

    expect(result.holdReason).toBe("infra_blocked");
    expect(result.retryAfterMs).toBeUndefined();
    expect(second.holdReason).toBe("empty");
    expect(h.queue.statusOf("run_b")).toBe("dequeued");
    expect(drives).toBe(1);
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    expect(h.batchEvents.events).toContainEqual(
      expect.objectContaining({
        type: "infra_blocked",
        specIds: ["spec_b"],
        terminal: true,
        consecutiveHolds: 1,
        kind: "ambiguous_merge_state",
      }),
    );
  });

  it("keeps a passing-batch ambiguity claimed when terminal batch event append fails before settlement", async () => {
    const h = makeHarness();
    h.queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    h.runner.driveMerge = async () => {
      throw new MergeAmbiguousError("merge PUT 504 and state could not be confirmed");
    };
    vi.spyOn(h.batchEvents, "emitInfraBlocked").mockRejectedValueOnce(new Error("event store unavailable"));

    await expect(h.coordinator.coordinate("project_batch")).rejects.toThrow("event store unavailable");

    expect(h.queue.statusOf("run_a")).toBe("merging");
  });
});
