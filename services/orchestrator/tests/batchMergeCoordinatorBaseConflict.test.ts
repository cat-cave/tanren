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
import { RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
import type { SpecPriority } from "../src/engine/state/spec.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
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
}

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const coordinator = new BatchMergeCoordinator({
    authorityEvaluator: allowExactBatchAuthority(),
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
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
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "rebase deferred; re-ready pending",
      recovery: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_replan_b", plannerTaskId: "task_replan_b" },
      },
    });

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("conflict");
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  it("a transient base-conflict drive throw holds and leaves the culprit queued", async () => {
    const h = makeHarness();
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RefResetTransientError("resolver runner allocate hit duplicate runners_pkey");
    };

    const result = await h.coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("a lost base-conflict claim self-wakes after the winning claim lease", async () => {
    const h = makeHarness();
    let now = 1_000_000;
    h.queue.now = () => now;
    seed(h, "spec_b");
    h.checker.baseConflictWhenContains("spec_b");
    const originalClaim = h.queue.claim.bind(h.queue);
    let claimAttempts = 0;
    h.queue.claim = async (queueId) => {
      claimAttempts += 1;
      if (claimAttempts === 1) {
        await originalClaim(queueId);
        return false;
      }
      return originalClaim(queueId);
    };

    const serialized = await h.coordinator.coordinate(PROJECT);

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(h.runner.drives).toEqual([]);
    expect(h.queue.statusOf("run_spec_b")).toBe("merging");

    now += serialized.retryAfterMs!;
    const recovered = await h.coordinator.coordinate(PROJECT);

    expect(recovered.mergedSpecId).toBe("spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.runner.drives).toEqual([{ runId: "run_spec_b" }]);
  });

  it("a SPEC-vs-SPEC conflict (conflictsWithBase false) bisects, lands prefix, then drives culprit", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");
    // Prefix A (and C is after culprit so not in innocent prefix of B at index 1) merges;
    // culprit B is driven through the resolver with a durable owner receipt.
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

    await h.coordinator.coordinate(PROJECT);

    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(true);
    expect(h.batchEvents.events.find((e) => e.type === "culprit")?.culpritSpecId).toBe("spec_b");
    // Culprit is DRIVEN (never a silent forever-dequeue without resolver).
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_a");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("conflict");
  });
});
