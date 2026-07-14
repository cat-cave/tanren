// Pure + dual-coordinator recovery ownership proofs (audit follow-up to PR #928).
// SpecNotRunnableError is never ownership; settlement rejects wrong-spec / empty IDs;
// EventEmittingMergeCoordinator shares the batch writer-rework failed-drive policy.

import { describe, expect, it } from "vitest";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import { isDurableOwnedReceipt, isRecoveryTerminalSpecStatus } from "../src/engine/merge/recoveryOwnership.js";
import { EventEmittingMergeCoordinator } from "../src/engine/merge/coordinator.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { RecordingBatchGateReworkRouter } from "./conformance/fakes/inMemoryBatchChecker.js";

describe("isDurableOwnedReceipt — structural settlement gate", () => {
  const ownedEnqueued = (specId: string, runId = "run_r", taskId = "task_r"): ConflictRecoveryReceipt => ({
    kind: "planner_replan",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId: taskId },
  });

  it("accepts a matching enqueued receipt with non-empty ids", () => {
    expect(isDurableOwnedReceipt(ownedEnqueued("spec_a"), "spec_a")).toBe(true);
  });

  it("rejects wrong-spec ownership", () => {
    expect(isDurableOwnedReceipt(ownedEnqueued("spec_other"), "spec_a")).toBe(false);
  });

  it("rejects empty enqueued identifiers", () => {
    expect(isDurableOwnedReceipt(ownedEnqueued("spec_a", "", "task"), "spec_a")).toBe(false);
    expect(isDurableOwnedReceipt(ownedEnqueued("spec_a", "run", "  "), "spec_a")).toBe(false);
  });

  it("rejects already_running without a non-empty runId", () => {
    expect(
      isDurableOwnedReceipt(
        { kind: "writer_rework", specId: "spec_a", run: { kind: "already_running", runId: "" } },
        "spec_a",
      ),
    ).toBe(false);
  });

  it("accepts already_running with a proven runId for the exact spec", () => {
    expect(
      isDurableOwnedReceipt(
        { kind: "writer_rework", specId: "spec_a", run: { kind: "already_running", runId: "run_live" } },
        "spec_a",
      ),
    ).toBe(true);
  });
});

describe("isRecoveryTerminalSpecStatus", () => {
  it("treats merged and cancelled as terminal fail-closed targets", () => {
    expect(isRecoveryTerminalSpecStatus("merged")).toBe(true);
    expect(isRecoveryTerminalSpecStatus("cancelled")).toBe(true);
    expect(isRecoveryTerminalSpecStatus("open")).toBe(false);
    expect(isRecoveryTerminalSpecStatus("in_flight")).toBe(false);
    expect(isRecoveryTerminalSpecStatus("needs_attention")).toBe(false);
  });
});

describe("EventEmittingMergeCoordinator — failed-drive parity with batch writer-rework policy", () => {
  const PROJECT = "project_parity";

  it("routes a failed drive to writer rework when gateRework is wired", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const gateRework = new RecordingBatchGateReworkRouter();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", { kind: "failed", message: "fresh pre_merge failed" });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      gateRework,
    });

    const result = await coordinator.coordinate(PROJECT);

    expect(result.dequeuedSpecId).toBe("spec_a");
    expect(gateRework.routed.map((r) => r.specId)).toEqual(["spec_a"]);
    expect(queue.dequeueReasonOf("run_a")).toBe("superseded");
    expect(escalator.escalations).toEqual([]);
  });

  it("parks needs_attention when no writer-rework router is configured", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", { kind: "failed", message: "fresh pre_merge failed" });
    const coordinator = new EventEmittingMergeCoordinator({ queue, runner, events, escalator });

    await coordinator.coordinate(PROJECT);

    expect(queue.dequeueReasonOf("run_a")).toBe("needs_attention");
    expect(escalator.escalations.map((e) => e.specId)).toEqual(["spec_a"]);
  });

  it("rejects a conflict owned receipt for the wrong spec", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", {
      kind: "conflict",
      message: "wrong owner",
      recovery: {
        kind: "planner_replan",
        specId: "spec_other",
        run: { kind: "enqueued", replanRunId: "r", plannerTaskId: "t" },
      },
    });
    const coordinator = new EventEmittingMergeCoordinator({ queue, runner, events, escalator });

    await coordinator.coordinate(PROJECT);

    expect(queue.dequeueReasonOf("run_a")).toBe("needs_attention");
    expect(escalator.escalations.map((e) => e.specId)).toEqual(["spec_a"]);
  });
});
