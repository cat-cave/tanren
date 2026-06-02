// In-memory MergeQueueModel + MergeRunner fakes for the MergeCoordinator
// conformance + unit tests (TEST FIXTURE — tests/ only, never production). The
// queue model holds entries in a Map and supports the full enqueue / loadSnapshot /
// atomic claim / settle / crash-recovery surface; the runner returns scripted
// outcomes + records each drive. Together they let the REAL EventEmittingMergeCoordinator
// run against a controllable queue with no DB or VCS.

import { randomUUID } from "node:crypto";
import type {
  MergeDriveOutcome,
  MergeQueueEntry,
  MergeQueueModel,
  MergeQueueSnapshot,
  MergeRunner,
} from "../../../src/engine/contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "../../../src/engine/merge/coordinator.js";
import type { SpecPriority } from "../../../src/engine/state/spec.js";

interface QueueRow {
  queueId: string;
  runId: string;
  specId: string;
  prUrl: string;
  prNumber: number;
  dependsOn: string[];
  priority: SpecPriority;
  orderKey: number;
  status: "queued" | "merging" | "merged" | "dequeued";
}

/** An in-memory native-queue model — the same observable contract as the pg impl. */
export class InMemoryMergeQueueModel implements MergeQueueModel {
  private readonly rows = new Map<string, QueueRow>();
  private readonly mergedSpecs = new Set<string>();
  private order = 0;

  /** Test helper: seed a queued entry directly (an already-enqueued ready run). */
  seed(input: { runId: string; specId: string; dependsOn: string[]; priority: SpecPriority }): void {
    const queueId = `mq_${randomUUID()}`;
    this.order += 1;
    this.rows.set(queueId, {
      queueId,
      runId: input.runId,
      specId: input.specId,
      prUrl: `https://github.test/pr/${input.runId}`,
      prNumber: this.order,
      dependsOn: input.dependsOn,
      priority: input.priority,
      orderKey: this.order,
      status: "queued",
    });
  }

  /** Test helper: mark a spec genuinely merged (a satisfied ancestor). */
  markSpecMerged(specId: string): void {
    this.mergedSpecs.add(specId);
  }

  /** Test helper: the status of a run's entry (the observable settle effect). */
  statusOf(runId: string): QueueRow["status"] | undefined {
    for (const row of this.rows.values()) {
      if (row.runId === runId) return row.status;
    }
    return undefined;
  }

  async enqueue(input: {
    projectId: string;
    runId: string;
    specId: string;
    prUrl: string;
    prNumber: number;
  }): Promise<{ queueId: string; created: boolean }> {
    for (const row of this.rows.values()) {
      if (row.runId === input.runId && (row.status === "queued" || row.status === "merging")) {
        return { queueId: row.queueId, created: false };
      }
    }
    const queueId = `mq_${randomUUID()}`;
    this.order += 1;
    this.rows.set(queueId, {
      queueId,
      runId: input.runId,
      specId: input.specId,
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      dependsOn: [],
      priority: "tbd",
      orderKey: this.order,
      status: "queued",
    });
    return { queueId, created: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadSnapshot(projectId: string): Promise<MergeQueueSnapshot> {
    const entries: MergeQueueEntry[] = [];
    let mergingInFlight = false;
    for (const row of this.rows.values()) {
      if (row.status === "merging") mergingInFlight = true;
      if (row.status !== "queued") continue;
      entries.push({
        queueId: row.queueId,
        runId: row.runId,
        specId: row.specId,
        prUrl: row.prUrl,
        prNumber: row.prNumber,
        dependsOn: row.dependsOn,
        priority: row.priority,
        orderKey: row.orderKey,
      });
    }
    return { projectId, entries, mergedSpecIds: new Set(this.mergedSpecs), mergingInFlight };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async claim(queueId: string): Promise<boolean> {
    const row = this.rows.get(queueId);
    if (row === undefined || row.status !== "queued") return false;
    row.status = "merging";
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markMerged(queueId: string): Promise<void> {
    const row = this.rows.get(queueId);
    if (row !== undefined) {
      row.status = "merged";
      // A merged entry's spec becomes a satisfied ancestor (the merge-stage effect).
      this.mergedSpecs.add(row.specId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markDequeued(queueId: string): Promise<void> {
    const row = this.rows.get(queueId);
    if (row !== undefined) row.status = "dequeued";
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recoverStaleClaims(_projectId: string): Promise<number> {
    let recovered = 0;
    for (const row of this.rows.values()) {
      if (row.status === "merging") {
        row.status = "queued";
        recovered += 1;
      }
    }
    return recovered;
  }
}

/** A scripted, recording merge runner — returns the scripted outcome per run id. */
export class ScriptedMergeRunner implements MergeRunner {
  readonly drives: { runId: string }[] = [];
  private readonly scripted = new Map<string, MergeDriveOutcome>();

  script(runId: string, outcome: MergeDriveOutcome): void {
    this.scripted.set(runId, outcome);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    this.drives.push({ runId: input.runId });
    return this.scripted.get(input.runId) ?? { kind: "merged", mergeSha: `sha_${input.runId}` };
  }
}

/** A recording queue-event emitter — captures every emitted queue event. */
export class RecordingMergeQueueEventEmitter implements MergeQueueEventEmitter {
  readonly events: {
    type: "merge.queue.advanced" | "merge.dequeued";
    specId: string;
    reason?: "conflict" | "blocked" | "failed";
    queueDepth?: number;
  }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitAdvanced(input: { entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    this.events.push({ type: "merge.queue.advanced", specId: input.entry.specId, queueDepth: input.queueDepth });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitDequeued(input: { entry: MergeQueueEntry; reason: "conflict" | "blocked" | "failed" }): Promise<void> {
    this.events.push({ type: "merge.dequeued", specId: input.entry.specId, reason: input.reason });
  }
}
