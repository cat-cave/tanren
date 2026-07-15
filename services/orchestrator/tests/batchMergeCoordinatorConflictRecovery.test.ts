// Spec-vs-spec bisect: land innocent prefix first, then drive the culprit through
// the per-run conflict path. Retire only on durable owner receipt or atomic park.

import { describe, expect, it } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

const PROJECT = "proj_conflict_recovery";

async function enqueueAB(queue: InMemoryMergeQueueModel): Promise<void> {
  await queue.enqueue({
    projectId: PROJECT,
    runId: "run_spec_a",
    specId: "spec_a",
    prUrl: "https://example.test/a",
    prNumber: 1,
    dependsOn: [],
    priority: "normal",
    orderKey: 1,
  });
  await queue.enqueue({
    projectId: PROJECT,
    runId: "run_spec_b",
    specId: "spec_b",
    prUrl: "https://example.test/b",
    prNumber: 2,
    dependsOn: [],
    priority: "normal",
    orderKey: 2,
  });
}

function harness(opts?: { rejectOwnership?: boolean }) {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const recoveryEvidence = new ScriptedRecoveryEvidencePort(
    opts?.rejectOwnership === true ? "reject-all" : "accept-structural",
  );
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    recoveryEvidence,
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator };
}

describe("BatchMergeCoordinator conflict recovery (prefix-first + exact ownership)", () => {
  it("lands innocent prefix A before driving conflict culprit B", async () => {
    const h = harness();
    await enqueueAB(h.queue);
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_a", { kind: "merged" });
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "resolver routed replan",
      recovery: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_replan_b", plannerTaskId: "task_replan_b" },
      },
    });

    const result = await h.coordinator.coordinate(PROJECT);
    const driveOrder = h.runner.drives.map((d) => d.runId);
    expect(driveOrder[0]).toBe("run_spec_a");
    expect(driveOrder).toContain("run_spec_b");
    expect(driveOrder.indexOf("run_spec_a")).toBeLessThan(driveOrder.indexOf("run_spec_b"));
    expect(result.mergedSpecId).toBe("spec_a");
    expect(result.dequeuedSpecId).toBe("spec_b");
    expect(h.events.events.filter((e) => e.type === "merge.dequeued" && e.reason === "conflict")).toHaveLength(1);
  });

  it("does not drive culprit when innocent prefix fails to fully land", async () => {
    const h = harness();
    await enqueueAB(h.queue);
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_a", { kind: "blocked", message: "transient authority hold" });
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "should never drive",
      recovery: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "x", plannerTaskId: "y" },
      },
    });

    await h.coordinator.coordinate(PROJECT);
    const driveOrder = h.runner.drives.map((d) => d.runId);
    expect(driveOrder).toEqual(["run_spec_a"]);
    expect(driveOrder).not.toContain("run_spec_b");
  });

  it("parks when ownership evidence is rejected (never conflict-dequeue)", async () => {
    const h = harness({ rejectOwnership: true });
    await h.queue.enqueue({
      projectId: PROJECT,
      runId: "run_spec_b",
      specId: "spec_b",
      prUrl: "https://example.test/b",
      prNumber: 2,
      dependsOn: [],
      priority: "normal",
      orderKey: 2,
    });
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "claimed replan without store proof",
      recovery: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_fake", plannerTaskId: "task_fake" },
      },
    });

    await h.coordinator.coordinate(PROJECT);
    expect(h.escalator.escalations.length).toBeGreaterThan(0);
    expect(h.events.events.filter((e) => e.type === "merge.dequeued" && e.reason === "conflict")).toEqual([]);
  });
});
