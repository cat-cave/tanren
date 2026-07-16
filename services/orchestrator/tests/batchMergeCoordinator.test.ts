import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
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
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { allowExactBatchAuthority } from "./helpers/mq2BatchAuthority.js";

const PROJECT = "project_batch";

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

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const gateRework = new RecordingBatchGateReworkRouter();
  const coordinator = new BatchMergeCoordinator({
    authorityEvaluator: allowExactBatchAuthority(),
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    gateRework,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
    // Run the bounded infra-error retries instantly (no real backoff in tests).
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework };
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

  // The gate-fail → writer-rework bisect routing + the conflict-vs-gate-fail distinction
  // live in batchMergeCoordinatorGateRework.test.ts (the v35 strand fix).

  it("ESCALATES a needs_attention real-merge outcome to needs_attention (non-bricking, NOT the recoverable conflict path)", async () => {
    const h = makeHarness();
    // The batch check PASSES, but spec_b's REAL merge drive returns the genuinely-
    // irreconcilable `needs_attention` outcome (the resolver's verdict the speculative
    // check could not see). It must PARK at needs_attention, never re-execute.
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.runner.script("run_spec_b", {
      kind: "needs_attention",
      message: "irreconcilable with spec_z",
      parking: "required",
    });

    await h.coordinator.coordinate(PROJECT);

    // spec_a (driven first, DAG order) merged; spec_b is ESCALATED + dequeued
    // `needs_attention` — the batch STOPS (no dependent merges past the parked spec).
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    // The spec was parked at needs_attention via the shared escalator (the loud event).
    expect(h.escalator.escalations).toEqual([{ specId: "spec_b", message: "irreconcilable with spec_z" }]);
    // Dequeued with the TERMINAL needs_attention reason — NOT the recoverable conflict.
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("needs_attention");
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(result.retryAfterMs).toBeGreaterThan(0);
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

  it("Bug B: a pending verdict returns a hold WITH retryAfterMs (default 15000 when no settle remainder)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // A registered-CI pending (no settleAfterMs) → the default recheck interval.
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    // The hold carries a backoff so the subscriber arms one timer instead of hot-looping.
    expect(result.retryAfterMs).toBe(15_000);
  });

  it("Bug B: a no-checks pending verdict wakes EXACTLY at the settle remainder (settleAfterMs)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // The no-checks settle: 12s remaining of the grace.
    h.checker.pendingWhenContains("spec_b");
    h.checker.pendingSettlesAfter(12_000);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    // retryAfterMs == the settle remainder so the re-drive fires exactly at expiry.
    expect(result.retryAfterMs).toBe(12_000);
  });

  it("routes an integration-conflict batch through bisect (the conflicting PR is the culprit)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "resolver routed replan",
      recovery: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_replan_b", plannerTaskId: "task_replan_b" },
      },
    });

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    // Post-culprit remainder waits for the next pass (conflict drive ends this pass).
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
  });

  it("holds on an empty queue (nothing to check)", async () => {
    const h = makeHarness();
    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("empty");
    expect(h.checker.checked).toEqual([]);
  });
});
