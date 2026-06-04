// Behavior tests for the BASE-CONFLICT routing in the BatchMergeCoordinator (the fix:
// a `conflict` whose `conflictBetween.otherSpecId` is the BASE branch — a single PR
// dirty against `default_branch` — is DRIVEN through the EXISTING per-run merge path
// `driveMerge` (rebase onto base → intent-preserving resolver → re-gate → re-push),
// NOT bisected/dequeued). Previously the batch coordinator dequeued such a PR to
// `conflict` and NOTHING re-admitted it, so the run stalled forever. These prove:
//   - a base-conflict culprit is DRIVEN (driveMerge), never `markDequeued(..,"conflict")`;
//   - a resolved/merged drive outcome → markMerged;
//   - a needs_attention drive outcome → the spec parks at needs_attention (the resolver's
//     genuine-product-clash verdict — the bounded resolver already decided this);
//   - a SPEC-vs-SPEC conflict (`conflictsWithBase` false) STILL bisects (unchanged).

import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import type { SpecPriority } from "../src/engine/state/spec.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";

const PROJECT = "project_batch";

interface Harness {
  coordinator: BatchMergeCoordinator;
  queue: InMemoryMergeQueueModel;
  runner: ScriptedMergeRunner;
  checker: InMemoryBatchChecker;
  events: RecordingMergeQueueEventEmitter;
  batchEvents: RecordingBatchMergeEventEmitter;
  escalator: RecordingSpecEscalator;
}

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — base-conflict routing (drive, not bisect)", () => {
  it("a PR dirty against the base is DRIVEN through the per-run resolver (driveMerge), NOT bisected/dequeued", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b is a SINGLE PR dirty against main (conflictsWithBase). It must be driven
    // through the real per-run merge path (the SAME driveMerge the merge step uses), where
    // the intent-preserving resolver rebases + resolves — NOT bisected/dequeued.
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    await h.coordinator.coordinate(PROJECT);

    // driveMerge WAS invoked for the culprit (the per-run resolver path), and the resolved
    // (default merged) outcome merged it — NOT a conflict-dequeue.
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    // markDequeued was never called with the conflict reason; no false-blame culprit event.
    expect(dequeueSpy).not.toHaveBeenCalledWith(expect.anything(), "conflict");
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  it("a needs_attention drive outcome PARKS the culprit at needs_attention (the resolver's genuine-clash verdict)", async () => {
    const h = makeHarness();
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    // The per-run resolver judged the rebase a genuine product clash → needs_attention.
    h.runner.script("run_spec_b", { kind: "needs_attention", message: "base resolve hit a genuine product clash" });

    await h.coordinator.coordinate(PROJECT);

    // The culprit was DRIVEN (not bisected) and parked at needs_attention via the escalator.
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.escalator.escalations).toEqual([
      { specId: "spec_b", message: "base resolve hit a genuine product clash" },
    ]);
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("needs_attention");
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
  });

  it("a recoverable conflict drive outcome dequeues recoverably (resolver re-readies the run) — still NOT a bisect", async () => {
    const h = makeHarness();
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    // The drive returns the recoverable `conflict` (the resolver re-readies the run for re-execution).
    h.runner.script("run_spec_b", { kind: "conflict", message: "rebase deferred; re-ready pending" });

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("conflict");
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  it("a SPEC-vs-SPEC conflict (conflictsWithBase false) STILL bisects-and-dequeues (unchanged)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    // A genuine spec-vs-spec integration conflict — the bisect-and-dequeue path is unchanged.
    h.checker.conflictWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    // It went through bisect (the culprit was named) — NOT the driveMerge resolver path.
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(true);
    expect(h.batchEvents.events.find((e) => e.type === "culprit")?.culpritSpecId).toBe("spec_b");
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_b");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("conflict");
  });
});
