// (autonomy-engine.md §2d) — serialization hardening: `recoverStaleClaims` is
// PROGRESS-GUARDED. A merge claim survives while its ActivityWatchdog advances;
// an unchanged heartbeat is safely reclaimed on the coordinator's next re-drive.
//
// Driven against the in-memory model, whose heartbeat recovery semantics mirror the
// pg implementation. Its heartbeat clock is injectable for deterministic progress.

import { describe, expect, it } from "vitest";
import type { MergeDriveOutcome, MergeRunner } from "../src/engine/contracts/mergeCoordinator.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { InMemoryBatchChecker, RecordingBatchMergeEventEmitter } from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import { allowExactBatchAuthority } from "./helpers/mq2BatchAuthority.js";
import { MERGE_QUEUE_PROGRESS_RECHECK_MS } from "../src/engine/merge/mergeSerializedRetry.js";

class ActivityControlledMergeRunner implements MergeRunner {
  readonly drives: { runId: string }[] = [];
  private onWatchdogProgress: (() => void) | undefined;
  private releaseFirstDrive!: () => void;
  private resolveFirstDriveStarted!: () => void;
  readonly firstDriveStarted = new Promise<void>((resolve) => {
    this.resolveFirstDriveStarted = resolve;
  });
  private readonly firstDriveReleased = new Promise<void>((resolve) => {
    this.releaseFirstDrive = resolve;
  });

  async driveMerge(input: {
    runId: string;
    projectId: string;
    onWatchdogProgress?: () => void;
  }): Promise<MergeDriveOutcome> {
    this.drives.push({ runId: input.runId });
    if (this.drives.length > 1) return { kind: "merged", mergeSha: `sha_${input.runId}` };
    this.onWatchdogProgress = input.onWatchdogProgress;
    this.resolveFirstDriveStarted();
    await this.firstDriveReleased;
    return { kind: "merged", mergeSha: `sha_${input.runId}` };
  }

  signalWatchdogProgress(): void {
    this.onWatchdogProgress?.();
  }

  release(): void {
    this.releaseFirstDrive();
  }
}

function coordinatorFor(queue: InMemoryMergeQueueModel, runner: MergeRunner): BatchMergeCoordinator {
  const events = new RecordingMergeQueueEventEmitter();
  return new BatchMergeCoordinator({
    authorityEvaluator: allowExactBatchAuthority(),
    resolveMaxBatchSize: async () => 1,
    queue,
    runner,
    checker: new InMemoryBatchChecker(),
    batchEvents: new RecordingBatchMergeEventEmitter(),
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    events,
    escalator: new RecordingSpecEscalator(),
  });
}

describe("recoverStaleClaims progress heartbeat (P2d serialization hardening)", () => {
  it("a FRESH merging claim SURVIVES a concurrent coordinate pass (not reclaimed)", async () => {
    const queue = new InMemoryMergeQueueModel();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    const claimed = await queue.claim(snap.entries[0].queueId);
    expect(claimed).toBe(true);
    expect(queue.statusOf("run_a")).toBe("merging");

    // A fresh heartbeat is progress evidence: another pass must not reclaim it.
    now += MERGE_QUEUE_PROGRESS_RECHECK_MS - 1;
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(0);
    // The fresh claim is intact — the other coordinator cannot double-drive it.
    expect(queue.statusOf("run_a")).toBe("merging");
  });

  it("a merging claim with no progress heartbeat IS reclaimed → queued", async () => {
    const queue = new InMemoryMergeQueueModel();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    await queue.claim(snap.entries[0].queueId);

    // The re-drive observes no ActivityWatchdog progress for a full cadence.
    now += MERGE_QUEUE_PROGRESS_RECHECK_MS;
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(1);
    // Reclaimed so the queue makes progress — a new pass can re-drive it.
    expect(queue.statusOf("run_a")).toBe("queued");
  });

  it("renews a progressing drive and reclaims a silent one", async () => {
    const progressingQueue = new InMemoryMergeQueueModel();
    const progressingRunner = new ActivityControlledMergeRunner();
    const progressingCoordinator = coordinatorFor(progressingQueue, progressingRunner);
    let now = 1_000_000;
    progressingQueue.now = () => now;
    progressingQueue.seed({ runId: "run_progressing", specId: "spec_progressing", dependsOn: [], priority: "tbd" });

    const progressingDrive = progressingCoordinator.coordinate("p");
    await progressingRunner.firstDriveStarted;
    // Each real watchdog signal renews the durable heartbeat. The elapsed time
    // between steps is irrelevant because each signal supplies fresh progress.
    for (let step = 0; step < 4; step += 1) {
      now += 60 * 60 * 1000;
      progressingRunner.signalWatchdogProgress();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    const concurrent = await progressingCoordinator.coordinate("p");
    expect(concurrent.holdReason).toBe("serialized");
    expect(progressingRunner.drives).toEqual([{ runId: "run_progressing" }]);
    expect(progressingQueue.statusOf("run_progressing")).toBe("merging");

    progressingRunner.release();
    await progressingDrive;

    const silentQueue = new InMemoryMergeQueueModel();
    const silentRunner = new ActivityControlledMergeRunner();
    const silentCoordinator = coordinatorFor(silentQueue, silentRunner);
    now = 2_000_000;
    silentQueue.now = () => now;
    silentQueue.seed({ runId: "run_silent", specId: "spec_silent", dependsOn: [], priority: "tbd" });
    const silentDrive = silentCoordinator.coordinate("p");
    await silentRunner.firstDriveStarted;
    now += MERGE_QUEUE_PROGRESS_RECHECK_MS;

    const recovered = await silentCoordinator.coordinate("p");
    expect(recovered.mergedSpecId).toBe("spec_silent");
    expect(silentRunner.drives).toEqual([{ runId: "run_silent" }, { runId: "run_silent" }]);

    silentRunner.release();
    await silentDrive;
  });

  it("aborts an in-flight drive when a progress heartbeat loses ownership", async () => {
    const queue = new InMemoryMergeQueueModel();
    queue.seed({ runId: "run_abort", specId: "spec_abort", dependsOn: [], priority: "tbd" });
    let landCalls = 0;
    const runner: MergeRunner = {
      async driveMerge(input) {
        input.onWatchdogProgress?.({ outputBytesAdvanced: 1, workSignatureAdvanced: true });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (input.claimSignal?.aborted === true) return { kind: "blocked", message: "claim lost" };
        if (input.confirmClaimBeforeLand !== undefined && !(await input.confirmClaimBeforeLand())) {
          return { kind: "blocked", message: "claim land fence lost" };
        }
        landCalls += 1;
        return { kind: "merged", mergeSha: "sha_abort" };
      },
    };
    queue.renewClaim = async () => false;

    const result = await coordinatorFor(queue, runner).coordinate("p");

    expect(landCalls).toBe(0);
    expect(result.mergedSpecId).toBeUndefined();
  });

  it("a serialized coordinator pass re-drives on cadence and reclaims no-progress work", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const coordinator = new BatchMergeCoordinator({
      authorityEvaluator: allowExactBatchAuthority(),
      resolveMaxBatchSize: async () => 1,
      queue,
      runner,
      checker: new InMemoryBatchChecker(),
      batchEvents: new RecordingBatchMergeEventEmitter(),
      recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
      events,
      escalator: new RecordingSpecEscalator(),
    });
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    await queue.claim(snap.entries[0].queueId);

    const serialized = await coordinator.coordinate("p");

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_a")).toBe("merging");

    now += serialized.retryAfterMs!;
    const recovered = await coordinator.coordinate("p");

    expect(recovered.mergedSpecId).toBe("spec_a");
    expect(queue.statusOf("run_a")).toBe("merged");
    expect(runner.drives).toEqual([{ runId: "run_a" }]);
  });

  it("a lost claim arms a cadence re-drive for the winning claim", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const coordinator = new BatchMergeCoordinator({
      authorityEvaluator: allowExactBatchAuthority(),
      resolveMaxBatchSize: async () => 1,
      queue,
      runner,
      checker: new InMemoryBatchChecker(),
      batchEvents: new RecordingBatchMergeEventEmitter(),
      recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
      events,
      escalator: new RecordingSpecEscalator(),
    });
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const originalClaim = queue.claim.bind(queue);
    let claimAttempts = 0;
    queue.claim = async (queueId) => {
      claimAttempts += 1;
      if (claimAttempts === 1) {
        await originalClaim(queueId);
        return false;
      }
      return originalClaim(queueId);
    };

    const serialized = await coordinator.coordinate("p");

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_a")).toBe("merging");

    now += serialized.retryAfterMs!;
    const recovered = await coordinator.coordinate("p");

    expect(recovered.mergedSpecId).toBe("spec_a");
    expect(queue.statusOf("run_a")).toBe("merged");
    expect(runner.drives).toEqual([{ runId: "run_a" }]);
  });
});
