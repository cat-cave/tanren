// THE RE-GATE BRICK FIX: a not-yet-terminal post-auto-rebase native re-gate must NEVER brick
// the DAG. The live brick: a spec was queued to merge, main moved, its branch auto-rebased,
// and the native re-gate exceeded its timeout budget → returned `pending`. The dispatcher
// emitted a TERMINAL "recoverable conflict" that DEQUEUED the entry and never recovered — the
// PR sat open/unmerged, the spec stayed in_flight, and the dependent percolated forever (9/11).
//
// The fix maps a not-yet-terminal re-gate to a distinct RE-DRIVABLE `re_gate_pending` outcome.
// These prove the coordinator's drive settle:
//   - `re_gate_pending` RELEASES the claim (entry STAYS queued) + holds with
//     `holdReason: "re_gate_pending"` + retryAfterMs, emits NO dequeue (never the brick);
//   - it RECOVERS: a later re-drive (the gate now terminal) merges the entry;
//   - it is UNBOUNDED while the gate is still running — repeated `re_gate_pending` NEVER
//     dequeues and NEVER hits a fixed attempt cap (a still-running gate is "not done yet",
//     not non-convergence; a human would say "wait for it").
//
// Contrast with the genuine terminal `conflict` outcome, which still dequeues (it hands off to
// the autonomous re-plan) — the brick was caused by a NOT-YET-TERMINAL gate being mislabelled
// as that terminal conflict.

import { describe, expect, it } from "vitest";
import type { MergeDriveOutcome, MergeRunner } from "../src/engine/contracts/mergeCoordinator.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
} from "./conformance/fakes/inMemoryMergeQueue.js";

/** A runner that returns a SCRIPTED outcome per drive, in order (so a hold-then-merge sequences). */
class ScriptedMergeRunner implements MergeRunner {
  readonly drives: { runId: string }[] = [];
  private readonly scripts = new Map<string, MergeDriveOutcome[]>();
  private readonly idx = new Map<string, number>();

  script(runId: string, outcomes: MergeDriveOutcome[]): void {
    this.scripts.set(runId, outcomes);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    this.drives.push({ runId: input.runId });
    const script = this.scripts.get(input.runId);
    if (script === undefined || script.length === 0) {
      return { kind: "merged", mergeSha: `sha_${input.runId}` };
    }
    const at = this.idx.get(input.runId) ?? 0;
    // Stay on the last scripted outcome once exhausted (a persistent-pending simulation).
    const outcome = script[Math.min(at, script.length - 1)] as MergeDriveOutcome;
    this.idx.set(input.runId, at + 1);
    return outcome;
  }
}

const PROJECT = "project_regate";

function harness(): {
  queue: InMemoryMergeQueueModel;
  runner: ScriptedMergeRunner;
  events: RecordingMergeQueueEventEmitter;
  coordinator: EventEmittingMergeCoordinator;
} {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const events = new RecordingMergeQueueEventEmitter();
  const coordinator = new BatchMergeCoordinator({
      resolveMaxBatchSize: async () => 1,
    queue,
    runner,
      checker: new InMemoryBatchChecker(),
      batchEvents: new RecordingBatchMergeEventEmitter(),
      recoveryEvidence: new ScriptedRecoveryEvidencePort(),
    events,
    escalator: new RecordingSpecEscalator(),
  });
  return { queue, runner, events, coordinator };
}

const seed = (queue: InMemoryMergeQueueModel, runId: string, specId: string): void =>
  queue.seed({ runId, specId, dependsOn: [], priority: "tbd" });

describe("EventEmittingMergeCoordinator — re_gate_pending native re-gate → recoverable re-drive (no brick)", () => {
  it("a re_gate_pending outcome RELEASES the claim (entry stays queued) + holds, never dequeues (the live brick)", async () => {
    const { queue, runner, events, coordinator } = harness();
    seed(queue, "run_p", "spec_p");
    runner.script("run_p", [{ kind: "re_gate_pending", message: "native re-gate not yet terminal after auto-rebase" }]);

    const result = await coordinator.coordinate(PROJECT);

    // HELD on re_gate_pending with a re-drive delay — NOT dequeued (the brick was a dequeue).
    expect(result.holdReason).toBe("merge_retry");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.dequeuedSpecId).toBeUndefined();
    // The entry is back in the queue (released claim) — the subscriber re-drive re-picks it.
    expect(queue.statusOf("run_p")).toBe("queued");
    // No merge.dequeued was emitted (the PR was never abandoned).
    expect(events.events.filter((e) => e.type === "merge.dequeued")).toEqual([]);
  });

  it("RECOVERS: a re_gate_pending hold then a later re-drive (gate now terminal) merges the entry", async () => {
    const { queue, runner, coordinator } = harness();
    seed(queue, "run_q", "spec_q");
    // The gate is still running on the first drive, terminal-green on the next.
    runner.script("run_q", [
      { kind: "re_gate_pending", message: "gate still running" },
      { kind: "merged", mergeSha: "cafef00d" },
    ]);

    // First pass: the gate is not yet terminal → hold (entry stays queued).
    const held = await coordinator.coordinate(PROJECT);
    expect(held.holdReason).toBe("merge_retry");
    expect(queue.statusOf("run_q")).toBe("queued");

    // The subscriber's delayed re-drive: a second pass — the gate finished — merges.
    const merged = await coordinator.coordinate(PROJECT);
    expect(merged.mergedSpecId).toBe("spec_q");
    expect(queue.statusOf("run_q")).toBe("merged");
  });

  it("UNBOUNDED while the gate is still running: many re_gate_pending passes NEVER dequeue, NEVER hit a fixed cap", async () => {
    const { queue, runner, events, coordinator } = harness();
    seed(queue, "run_u", "spec_u");
    // A long-running gate: every drive returns re_gate_pending. Drive far past the point a
    // SUSTAINED-non-recovery would alert on the `blocked` path — a still-running gate is NOT a
    // non-recovering infra failure (it is "not done yet", not non-convergence), so it never alerts.
    runner.script("run_u", [{ kind: "re_gate_pending", message: "gate still running" }]);

    for (let i = 0; i < 12; i += 1) {
      const result = await coordinator.coordinate(PROJECT);
      expect(result.holdReason).toBe("merge_retry");
      expect(result.retryAfterMs).toBeGreaterThan(0);
      // NEVER dequeued, NEVER an infra_blocked ceiling alert — a still-running gate is not stuck.
      expect(result.dequeuedSpecId).toBeUndefined();
      expect(queue.statusOf("run_u")).toBe("queued");
      expect(events.events.some((e) => e.type === "merge.dequeued" || e.type === "merge.queue.infra_blocked")).toBe(
        false,
      );
    }
    // It still RECOVERS when the gate finishes (no terminal state was ever entered).
    runner.script("run_u", [{ kind: "merged", mergeSha: "feedface" }]);
    const merged = await coordinator.coordinate(PROJECT);
    expect(merged.mergedSpecId).toBe("spec_u");
    expect(queue.statusOf("run_u")).toBe("merged");
  });

  it("a genuine terminal `conflict` still DEQUEUES (it hands off to autonomous re-plan) — only the not-yet-terminal gate is recoverable", async () => {
    const { queue, runner, coordinator } = harness();
    seed(queue, "run_c", "spec_c");
    runner.script("run_c", [{ kind: "conflict", message: "merge conflict", recovery: { kind: "planner_replan", specId: "spec_c", run: { kind: "enqueued", replanRunId: "r1", plannerTaskId: "t1" } } }]);

    const result = await coordinator.coordinate(PROJECT);

    expect(result.dequeuedSpecId).toBe("spec_c");
    expect(queue.statusOf("run_c")).toBe("dequeued");
    expect(queue.dequeueReasonOf("run_c")).toBe("conflict");
  });
});
