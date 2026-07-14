import { describe, expect, it, vi } from "vitest";
import { formBatch } from "../src/engine/contracts/batchMergeCoordinator.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { mapConflictDriveOutcome } from "../src/engine/merge/coordinatorBuild.js";
import { RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
import type { SpecPriority } from "../src/engine/state/spec.js";
import {
  InMemoryBatchChecker,
  RecordingBatchGateReworkRouter,
  RecordingBatchMergeEventEmitter,
} from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";

const PROJECT = "project_batch_conflict_recovery";

interface Harness {
  coordinator: BatchMergeCoordinator;
  queue: InMemoryMergeQueueModel;
  runner: ScriptedMergeRunner;
  checker: InMemoryBatchChecker;
  events: RecordingMergeQueueEventEmitter;
  batchEvents: RecordingBatchMergeEventEmitter;
  escalator: RecordingSpecEscalator;
  gateRework: RecordingBatchGateReworkRouter;
}

function makeHarness(wireGateRework = true): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const gateRework = new RecordingBatchGateReworkRouter();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    ...(wireGateRework ? { gateRework } : {}),
    resolveMaxBatchSize: () => Promise.resolve(8),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — conflict recovery ownership and order", () => {
  it("lands [A,B], scopes C's sustained infra rework to C, and leaves untouched D eligible", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    seed(h, "spec_d");
    h.checker.conflictWhenContains("spec_c");
    h.runner.driveMerge = async ({ runId }) => {
      h.runner.drives.push({ runId });
      if (runId === "run_spec_c") {
        throw new RefResetTransientError("persistent culprit resolver allocation outage");
      }
      return { kind: "merged" };
    };

    const first = await h.coordinator.coordinate(PROJECT);

    expect(first.holdReason).toBe("infra_error");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }, { runId: "run_spec_b" }, { runId: "run_spec_c" }]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    expect(h.queue.statusOf("run_spec_d")).toBe("queued");

    const sustained = await h.coordinator.coordinate(PROJECT);

    expect(sustained.holdReason).toBe("all_blocked");
    expect(h.runner.drives).toEqual([
      { runId: "run_spec_a" },
      { runId: "run_spec_b" },
      { runId: "run_spec_c" },
      { runId: "run_spec_c" },
    ]);
    expect(h.gateRework.routed.map((route) => route.specId)).toEqual(["spec_c"]);
    expect(h.queue.statusOf("run_spec_c")).toBe("dequeued");
    expect(h.queue.dequeueReasonOf("run_spec_c")).toBe("superseded");
    expect(h.queue.statusOf("run_spec_d")).toBe("queued");
    expect(h.events.events.filter((event) => event.type === "merge.dequeued").map((event) => event.specId)).toEqual([
      "spec_c",
    ]);
    const formation = formBatch(await h.queue.loadSnapshot(PROJECT), 8);
    expect(formation.batch.map((entry) => entry.specId)).toEqual(["spec_d"]);
  });

  it("holds serialized when the culprit claim is lost after the prefix, then recovers without reversing order", async () => {
    const h = makeHarness();
    let now = 1_000_000;
    h.queue.now = () => now;
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.conflictWhenContains("spec_b");
    const originalClaim = h.queue.claim.bind(h.queue);
    let claimCalls = 0;
    h.queue.claim = async (queueId) => {
      claimCalls += 1;
      if (claimCalls === 2) {
        await originalClaim(queueId);
        return false;
      }
      return originalClaim(queueId);
    };

    const serialized = await h.coordinator.coordinate(PROJECT);

    expect(serialized.holdReason).toBe("serialized");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merging");

    now += (serialized.retryAfterMs ?? 0) + 1;
    const recovered = await h.coordinator.coordinate(PROJECT);

    expect(recovered.mergedSpecId).toBe("spec_b");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }, { runId: "run_spec_b" }]);
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
  });

  it("does not drive the culprit when a passing-prefix member is still waiting on re-gate", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_c");
    h.runner.script("run_spec_b", { kind: "re_gate_pending", message: "prefix B pre_merge is still running" });

    const held = await h.coordinator.coordinate(PROJECT);

    expect(held.holdReason).toBe("merge_retry");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }, { runId: "run_spec_b" }]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    expect(h.gateRework.routed).toEqual([]);
  });

  it("does not drive the culprit after a partial-prefix claim loss", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_c");
    const originalClaim = h.queue.claim.bind(h.queue);
    let claimCalls = 0;
    h.queue.claim = async (queueId) => {
      claimCalls += 1;
      if (claimCalls === 2) {
        await originalClaim(queueId);
        return false;
      }
      return originalClaim(queueId);
    };

    const serialized = await h.coordinator.coordinate(PROJECT);

    expect(serialized.holdReason).toBe("serialized");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merging");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
  });

  it("routes a failed fresh conflict re-gate to writer ownership before retiring the stale entry", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_b", { kind: "failed", message: "fresh pre_merge test failed" });
    const routeSpy = vi.spyOn(h.gateRework, "routeGateFailToRework");
    const dequeueSpy = vi.spyOn(h.events, "emitDequeued");

    const result = await h.coordinator.coordinate(PROJECT);

    expect(h.gateRework.routed.map((route) => route.specId)).toEqual(["spec_b"]);
    expect(h.gateRework.routed[0]?.gateError).toContain("fresh pre_merge test failed");
    expect(routeSpy.mock.invocationCallOrder[0]).toBeLessThan(dequeueSpy.mock.invocationCallOrder[0] ?? 0);
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("superseded");
    expect(result.dequeuedSpecId).toBe("spec_b");
  });

  it("parks a failed fresh conflict re-gate at needs_attention when no rework router exists", async () => {
    const h = makeHarness(false);
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_b", { kind: "failed", message: "fresh pre_merge build failed" });

    await h.coordinator.coordinate(PROJECT);

    expect(h.gateRework.routed).toEqual([]);
    expect(h.escalator.escalations).toEqual([
      {
        specId: "spec_b",
        message:
          "merge drive failed fresh validation: fresh pre_merge build failed; no writer-rework router is configured",
      },
    ]);
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
  });

  it("scopes a sustained base-conflict drive failure to its named culprit", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.baseConflictWhenContains("spec_b");
    h.runner.driveMerge = async ({ runId }) => {
      h.runner.drives.push({ runId });
      throw new RefResetTransientError("persistent base-conflict resolver outage");
    };

    const first = await h.coordinator.coordinate(PROJECT);
    const sustained = await h.coordinator.coordinate(PROJECT);

    expect(first.holdReason).toBe("infra_error");
    expect(sustained.holdReason).toBe("all_blocked");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_b" }, { runId: "run_spec_b" }]);
    expect(h.gateRework.routed.map((route) => route.specId)).toEqual(["spec_b"]);
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    const formation = formBatch(await h.queue.loadSnapshot(PROJECT), 8);
    expect(formation.batch.map((entry) => entry.specId)).toEqual(["spec_a", "spec_c"]);
  });

  it("fails closed when a production merge conflict has no durable recovery owner", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    h.runner.script(
      "run_spec_b",
      mapConflictDriveOutcome({ message: "resolver returned conflict without routing a replan" }),
    );

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(h.escalator.escalations.map((entry) => entry.specId)).toEqual(["spec_b"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.events.events.filter((event) => event.type === "merge.dequeued").map((event) => event.specId)).toEqual([
      "spec_b",
    ]);
  });

  it("permits conflict retirement only with the resolver's durable planner receipt", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    h.runner.script(
      "run_spec_b",
      mapConflictDriveOutcome({
        message: "resolver routed a real replan",
        conflictRecovery: {
          kind: "owned",
          receipt: {
            kind: "planner_replan",
            specId: "spec_b",
            run: { kind: "enqueued", replanRunId: "run_replan_b", plannerTaskId: "task_replan_b" },
          },
        },
      }),
    );

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("conflict");
    expect(h.escalator.escalations).toEqual([]);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
  });

  it("routes a failed passing-batch prefix member to writer rework before dequeue", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.runner.script("run_spec_b", { kind: "failed", message: "fresh pre_merge failed on the advanced base" });
    const routeSpy = vi.spyOn(h.gateRework, "routeGateFailToRework");
    const dequeueSpy = vi.spyOn(h.events, "emitDequeued");

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives).toEqual([{ runId: "run_spec_a" }, { runId: "run_spec_b" }]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("superseded");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    expect(h.gateRework.routed.map((route) => route.specId)).toEqual(["spec_b"]);
    expect(routeSpy.mock.invocationCallOrder[0]).toBeLessThan(dequeueSpy.mock.invocationCallOrder[0] ?? 0);
  });

  it("parks a failed passing-batch prefix member when the writer router is absent", async () => {
    const h = makeHarness(false);
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.runner.script("run_spec_b", { kind: "failed", message: "fresh pre_merge failed without a router" });

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    expect(h.escalator.escalations.map((entry) => entry.specId)).toEqual(["spec_b"]);
  });

  it("parks a bisected gate-fail culprit when the writer router assembly is absent", async () => {
    const h = makeHarness(false);
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(h.escalator.escalations.map((entry) => entry.specId)).toEqual(["spec_b"]);
    expect(h.events.events.filter((event) => event.type === "merge.dequeued").map((event) => event.specId)).toEqual([
      "spec_b",
    ]);
  });
});
