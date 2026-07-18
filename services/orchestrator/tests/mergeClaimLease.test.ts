// (autonomy-engine.md §2d) — serialization hardening: `recoverStaleClaims` is
// LIVENESS-GUARDED. A live `merging` claim must survive for an arbitrarily long
// merge; only a coordinator that lost its PostgreSQL session fence is reclaimed.
//
// Driven against the in-memory model, whose liveness-fence recovery semantics mirror
// the pg implementation. Its heartbeat clock is injectable for deterministic progress.

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

describe("recoverStaleClaims liveness fence (P2d serialization hardening)", () => {
  it("a FRESH merging claim SURVIVES a concurrent coordinate pass (not reclaimed)", async () => {
    const queue = new InMemoryMergeQueueModel();
    let now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    const claimed = await queue.claim(snap.entries[0].queueId);
    expect(claimed).toBe(true);
    expect(queue.statusOf("run_a")).toBe("merging");

    // Elapsed time alone is irrelevant: the still-held process fence recovers NOTHING.
    now += 86_400_000;
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(0);
    // The fresh claim is intact — the other coordinator cannot double-drive it.
    expect(queue.statusOf("run_a")).toBe("merging");
  });

  it("a merging claim whose coordinator lost its liveness fence IS reclaimed → queued", async () => {
    const queue = new InMemoryMergeQueueModel();
    const now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    await queue.claim(snap.entries[0].queueId);

    // A crash releases the session fence; no expiry timestamp is involved.
    queue.loseClaimLiveness("run_a");
    const recovered = await queue.recoverStaleClaims("p");
    expect(recovered).toBe(1);
    // Reclaimed so the queue makes progress — a new pass can re-drive it.
    expect(queue.statusOf("run_a")).toBe("queued");
  });

  it("renews a long-but-live drive only on progress and never drops its claim by elapsed time", async () => {
    const progressingQueue = new InMemoryMergeQueueModel();
    const progressingRunner = new ActivityControlledMergeRunner();
    const progressingCoordinator = coordinatorFor(progressingQueue, progressingRunner);
    let now = 1_000_000;
    progressingQueue.now = () => now;
    progressingQueue.seed({ runId: "run_progressing", specId: "spec_progressing", dependsOn: [], priority: "tbd" });

    const progressingDrive = progressingCoordinator.coordinate("p");
    await progressingRunner.firstDriveStarted;
    // Each real watchdog signal renews the durable heartbeat. The wall clock can
    // advance far beyond the old 15-minute cap between arbitrary merge steps;
    // while this process remains live it is never reclaimed.
    for (let step = 0; step < 4; step += 1) {
      now += 60 * 60 * 1000;
      progressingRunner.signalWatchdogProgress();
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
    silentQueue.loseClaimLiveness("run_silent");

    const recovered = await silentCoordinator.coordinate("p");
    expect(recovered.mergedSpecId).toBe("spec_silent");
    expect(silentRunner.drives).toEqual([{ runId: "run_silent" }, { runId: "run_silent" }]);

    silentRunner.release();
    await silentDrive;
  });

  it("a serialized coordinator pass re-drives on cadence and later reclaims a dead fence", async () => {
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
    const now = 1_000_000;
    queue.now = () => now;
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    const snap = await queue.loadSnapshot("p");
    await queue.claim(snap.entries[0].queueId);

    const serialized = await coordinator.coordinate("p");

    expect(serialized.holdReason).toBe("serialized");
    expect(serialized.retryAfterMs).toBeGreaterThan(0);
    expect(runner.drives).toEqual([]);
    expect(queue.statusOf("run_a")).toBe("merging");

    queue.loseClaimLiveness("run_a");
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
    const now = 1_000_000;
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

    queue.loseClaimLiveness("run_a");
    const recovered = await coordinator.coordinate("p");

    expect(recovered.mergedSpecId).toBe("spec_a");
    expect(queue.statusOf("run_a")).toBe("merged");
    expect(runner.drives).toEqual([{ runId: "run_a" }]);
  });
});
