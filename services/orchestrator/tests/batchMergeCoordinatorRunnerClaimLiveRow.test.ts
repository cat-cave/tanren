// task #21A: the doctrine-alignment proof that a typed `RunnerClaimLiveRowError`
// (`retriable: false`) routes through the recoverable `merge_retry` hold path
// — NOT the retriable `infra_error` hot-loop apex v49 looped on for 8 hours.
//
// apex v49 hit `runners_pkey` raw from `PgRunnerStore.claim()`'s bare INSERT.
// `isRetriableInfraError` defaults UNTYPED errors to RETRIABLE
// (`engine/providers/githubRefReset.ts`), so the batch coordinator's
// `holdOnRetriableDriveThrow` returned an `infra_hold` → `holdReason:
// "infra_error"` and the merge subscriber re-drove forever (the runner-INSERT
// throws `runners_pkey` again every pass — a structural fixed point).
//
// task #21A made `claim()` throw the typed `RunnerClaimLiveRowError`
// (`retriable: false`) on a LIVE-row conflict. `isRetriableInfraError` reads
// the typed flag and returns false → `holdOnRetriableDriveThrow` returns
// undefined → the catch wraps as `{ kind: "blocked" }` →
// `settleDriveOutcome` reaches `holdOrHaltRecoverableDrive` (the recoverable
// sustained-non-recovery hold). The entry STAYS queued (autonomous recovery,
// never abandoned) but the hold is `merge_retry`, not `infra_error` — the
// hot-loop signature is gone, and the sustained-identical re-drive emits a
// LOUD `merge.queue.infra_blocked` alert (kind "ceiling") on the per-PR event
// emitter so a real fixed point surfaces loud.
//
// Doctrine: `docs/roadmap/timeout-eradication.md` §1 — a STRUCTURAL fixed
// point is NOT a transient.

import { describe, expect, it, vi } from "vitest";
import { RunnerClaimLiveRowError } from "../src/engine/allocators/runnerStore.js";
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
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

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

function makeHarness(): Harness {
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
    recoveryEvidence: new ScriptedRecoveryEvidencePort(),
    gateRework,
    resolveMaxBatchSize: () => Promise.resolve(5),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — task #21A: typed RunnerClaimLiveRowError routing", () => {
  it("routes to merge_retry (recoverable hold), NOT the retriable infra_error hot-loop", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RunnerClaimLiveRowError("runner_run_spec_a");
    };

    const first = await h.coordinator.coordinate(PROJECT);
    // The hot-loop signature is GONE — recoverable hold, not infra_error.
    expect(first.holdReason).toBe("merge_retry");
    expect(first.holdReason).not.toBe("infra_error");
    expect(first.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(dequeueSpy).not.toHaveBeenCalled();
    // First pass: not yet a sustained streak, so no loud infra_blocked alert.
    expect(h.events.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(false);
  });

  it("the IDENTICAL re-throw triggers a sustained-non-recovery infra_blocked alert (entry STAYS queued)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RunnerClaimLiveRowError("runner_run_spec_a");
    };

    await h.coordinator.coordinate(PROJECT);
    const second = await h.coordinator.coordinate(PROJECT);
    expect(second.holdReason).toBe("merge_retry");
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(dequeueSpy).not.toHaveBeenCalled();
    // The recoverable ceiling alert lands on the per-PR event emitter, kind
    // "ceiling" — non-terminal (recovery stays autonomous, never abandoned).
    const infraBlocked = h.events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(infraBlocked.length).toBeGreaterThanOrEqual(1);
    expect(infraBlocked[0]?.kind).toBe("ceiling");
    expect(infraBlocked[0]?.specId).toBe("spec_a");
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });
});
