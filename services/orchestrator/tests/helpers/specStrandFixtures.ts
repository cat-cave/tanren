// In-memory NEVER-STRAND reconciler seam fixtures (TEST FIXTURES — tests/ only,
// never src/). Shared by the strand-reconciler predicate/coordinator suite and the
// PR4 interplay/discipline suite (so each test file stays under the 500-line cap).
// The `FixedReadModel` returns scripted candidates + prior-unstrand counts; the
// `RecordingWriter`/`RecordingEmitter` capture the reconciler's flips + emitted
// events so a test asserts the heal/escalate behavior with no DB.

import type {
  SpecStrandEventEmitter,
  SpecStrandReadModel,
  SpecStrandSnapshot,
  SpecStrandWriter,
  StrandReason,
} from "../../src/engine/contracts/specStrandReconciler.js";

/** The project id every strand-fixture test reconciles under. */
export const PROJECT = "project_strand";

/** Build a strand snapshot with sensible defaults (an in-flight spec, one cancelled run). */
export function snapshot(over: Partial<SpecStrandSnapshot> & { specId: string }): SpecStrandSnapshot {
  return {
    status: "in_flight",
    runs: [{ runId: "run_old", status: "cancelled" }],
    hasActiveMergeQueueEntry: false,
    ...over,
  };
}

/** A scripted read model: fixed candidates + per-spec prior-unstrand counts. */
export class FixedReadModel implements SpecStrandReadModel {
  constructor(
    private candidates: SpecStrandSnapshot[],
    private priorUnstrands: Record<string, number> = {},
  ) {}
  setCandidates(candidates: SpecStrandSnapshot[]): void {
    this.candidates = candidates;
  }
  async loadStrandCandidates(): Promise<SpecStrandSnapshot[]> {
    return this.candidates;
  }
  async countPriorUnstrands(input: { specId: string }): Promise<number> {
    return this.priorUnstrands[input.specId] ?? 0;
  }
}

/** A recording writer: captures the re-enqueue / escalate / clear-marker flips. */
export class RecordingWriter implements SpecStrandWriter {
  readonly reEnqueued: string[] = [];
  readonly escalated: string[] = [];
  readonly clearedMarkers: string[] = [];
  /**
   * Whether the atomic guarded flip "moved a row". Default true (no concurrent
   * writer); a test sets it false to SIMULATE a concurrent re-exec that reclaimed the
   * spec between the reconciler's read and the flip — the heal must then be a no-op.
   */
  constructor(private readonly flipped = true) {}
  async reEnqueueSpec(input: { specId: string }): Promise<{ flipped: boolean }> {
    this.reEnqueued.push(input.specId);
    return { flipped: this.flipped };
  }
  async escalateSpec(input: { specId: string }): Promise<{ flipped: boolean }> {
    this.escalated.push(input.specId);
    return { flipped: this.flipped };
  }
  async clearOrphanedMarker(input: { runId: string }): Promise<void> {
    this.clearedMarkers.push(input.runId);
  }
}

/** A recording emitter: captures the dag.spec.unstranded / dag.spec.needs_attention payloads. */
export class RecordingEmitter implements SpecStrandEventEmitter {
  readonly unstranded: Array<{ specId: string; reason: StrandReason; attempt: number }> = [];
  readonly needsAttention: Array<{ specId: string; reason: StrandReason; attempts: number; message: string }> = [];
  async emitUnstranded(input: { specId: string; reason: StrandReason; attempt: number }): Promise<void> {
    this.unstranded.push({ specId: input.specId, reason: input.reason, attempt: input.attempt });
  }
  async emitNeedsAttention(input: {
    specId: string;
    reason: StrandReason;
    attempts: number;
    message: string;
  }): Promise<void> {
    this.needsAttention.push({
      specId: input.specId,
      reason: input.reason,
      attempts: input.attempts,
      message: input.message,
    });
  }
}
