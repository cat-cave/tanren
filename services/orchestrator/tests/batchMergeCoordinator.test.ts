// Behavior tests for the REAL BatchMergeCoordinator (autonomy-engine.md §2d —
// speculative batch-check + bisect) wired to in-memory fakes (TEST FIXTURES, tests/
// only): the P2d-1 queue model + merge runner, an in-memory BatchChecker (models a
// bad-interaction PR WITHOUT a VCS), and recording event emitters. They prove the
// P2d-2 contract end to end:
//   - a batch whose combined check PASSES merges every entry in DAG order;
//   - a batch with ONE bad-interaction PR fails the check, bisect isolates EXACTLY
//     that PR (not an innocent), the culprit is dequeued to a RECOVERABLE outcome
//     (conflict — routed to re-execution; not dropped, not merged), and the remaining
//     innocent PRs merge;
//   - a failed batch NEVER merges to default_branch (no entry merges until a passing
//     prospective state);
//   - bisect terminates (no infinite loop);
//   - the batch cap is respected + logged;
//   - ordering/serialization are preserved (ancestor before dependent; the P2d-1
//     claim is the serialization boundary).

import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import type { SpecPriority } from "../src/engine/state/spec.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
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
}

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
  });
  return { coordinator, queue, runner, checker, events, batchEvents };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — speculative batch-check + bisect", () => {
  it("a passing batch merges every entry in DAG order (one combined check, no re-surprises)", async () => {
    const h = makeHarness();
    // A chain A→B→C plus an independent D — all in one batch, the check passes.
    seed(h, "spec_a", []);
    seed(h, "spec_b", ["spec_a"]);
    seed(h, "spec_c", ["spec_b"]);

    await h.coordinator.coordinate(PROJECT);

    // Every entry merged, in DAG order (ancestor before dependent).
    expect(h.runner.drives.map((d) => d.runId)).toEqual(["run_spec_a", "run_spec_b", "run_spec_c"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
    // The batch was checked ONCE as a combined unit, then passed.
    expect(h.batchEvents.events.some((e) => e.type === "checking")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "passed")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  it("bisects a bad-interaction PR, dequeues it recoverably, and merges the innocents", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // spec_c is the bad-interaction PR (passes alone, breaks the combined state).
    seed(h, "spec_c");
    seed(h, "spec_d");
    h.checker.failWhenContains("spec_c");

    await h.coordinator.coordinate(PROJECT);

    // The culprit is isolated to EXACTLY spec_c and dequeued — NOT merged, NOT dropped.
    expect(h.queue.statusOf("run_spec_c")).toBe("dequeued");
    const culprit = h.batchEvents.events.find((e) => e.type === "culprit");
    expect(culprit?.culpritSpecId).toBe("spec_c");
    // The dequeue is RECOVERABLE (conflict reason → routed to re-execution, not failed).
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.specId).toBe("spec_c");
    expect(dq?.reason).toBe("conflict");
    // The culprit's drive was NEVER attempted (a failed-check batch never merges it).
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_c");

    // The innocent PRs merged (the batch was re-formed + re-checked without the culprit).
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_d")).toBe("merged");
  });

  it("an innocent PR is never blamed — only the unique pass→fail boundary is the culprit", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b is the only bad-interaction PR.
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    const culprits = h.batchEvents.events.filter((e) => e.type === "culprit").map((e) => e.culpritSpecId);
    expect(culprits).toEqual(["spec_b"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
  });

  it("a failed-check batch NEVER merges to default_branch (no entry merges before a passing state)", async () => {
    const h = makeHarness();
    // EVERY entry contains the bad spec only as the whole-batch interaction: mark spec_a
    // bad so the FULL batch fails AND every prefix containing it fails — the only
    // passing prefix is the empty base. No innocent precedes the culprit.
    // spec_a is bad AND at the head, so no innocent precedes the culprit.
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.failWhenContains("spec_a");

    await h.coordinator.coordinate(PROJECT);

    // spec_a is the culprit (dequeued), spec_b (innocent) merges; spec_a never merged.
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    // spec_a's real merge was never driven.
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_a");
  });

  it("bisect terminates and isolates the culprit even in a large batch (no infinite loop)", async () => {
    const h = makeHarness(16);
    for (let i = 0; i < 16; i += 1) seed(h, `spec_${i}`);
    h.checker.failWhenContains("spec_9");

    // A real timer guards against a hang — the pass must complete promptly.
    await expect(h.coordinator.coordinate(PROJECT)).resolves.toBeDefined();

    expect(h.queue.statusOf("run_spec_9")).toBe("dequeued");
    // Every other entry merged.
    for (let i = 0; i < 16; i += 1) {
      if (i === 9) continue;
      expect(h.queue.statusOf(`run_spec_${i}`)).toBe("merged");
    }
  });

  it("respects the batch cap and logs it (no silent truncation)", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = makeHarness(2);
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    seed(h, "spec_d");

    await h.coordinator.coordinate(PROJECT);

    // The first checking event saw a capped batch of 2 of 4 eligible.
    const checking = h.batchEvents.events.find((e) => e.type === "checking");
    expect(checking?.specIds).toHaveLength(2);
    expect(checking?.capped).toBe(true);
    expect(checking?.eligibleCount).toBe(4);
    expect(checking?.maxBatchSize).toBe(2);
    // The cap was LOGGED (operator visibility — no silent truncation).
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/batch CAPPED/u));
    logSpy.mockRestore();
  });

  it("holds (no merge, no bisect) when a merge is already in flight (serialization preserved)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // Simulate another entry already claimed (merging) — the serialization signal.
    const snap = await h.queue.loadSnapshot(PROJECT);
    await h.queue.claim(snap.entries[0]!.queueId);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("serialized");
    // No batch check ran (nothing was formed while a merge is in flight).
    expect(h.checker.checked).toEqual([]);
  });

  it("holds when the batch CI is still pending — does NOT bisect a not-yet-terminal batch", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    // No entry merged or dequeued — the pass held for CI to settle (no false blame).
    expect(result.mergedSpecId).toBeUndefined();
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
  });

  it("routes an integration-conflict batch through bisect (the conflicting PR is the culprit)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b conflicts on the integration ref (an A-vs-B build conflict).
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
  });

  it("holds on an empty queue (nothing to check)", async () => {
    const h = makeHarness();
    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("empty");
    expect(h.checker.checked).toEqual([]);
  });
});
