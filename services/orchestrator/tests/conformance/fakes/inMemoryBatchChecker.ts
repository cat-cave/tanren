// In-memory BatchChecker + batch-event emitter fakes for the BatchMergeCoordinator
// tests (TEST FIXTURE — tests/ only, never production). The checker models the
// PROSPECTIVE-MERGED-STATE check WITHOUT a VCS: a test marks certain spec ids as
// "bad-interaction" specs, and the checker FAILS any entry-set that contains a bad
// spec (modelling PRs that pass alone but break together). It records every checked
// entry-set so a test can assert the bisect's probe sequence. The event emitter
// records every merge.batch.* event for assertion.

import type {
  BatchCheckVerdict,
  BatchChecker,
  BatchFormation,
} from "../../../src/engine/contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../../../src/engine/contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "../../../src/engine/merge/batchCoordinator.js";

/**
 * An in-memory batch checker. By default every entry-set PASSES. A test marks a spec
 * id as a BAD-INTERACTION spec (`failWhenContains`): any checked entry-set that
 * includes it then FAILS — exactly the "this PR breaks the combined state" signal the
 * bisect must isolate. A spec marked `conflictWhenContains` reports an integration
 * conflict instead. A spec marked `pendingWhenContains` reports a still-running CI.
 *
 * INFRA ERROR modelling (Bug 2): the checker can be made to THROW (the check could not
 * be RUN — a transient ref/transport error, NOT a CI verdict). `throwInfraAlways(error)`
 * throws on every call (a PERSISTENT infra error). `throwInfraOnce(error)` throws on the
 * first call then behaves normally (a transient-then-success). The coordinator must map
 * a thrown checker to the `infra-error` verdict + retry/hold, never a fail/dequeue.
 */
export class InMemoryBatchChecker implements BatchChecker {
  /** Every entry-set checked, in order (the spec-id lists) — the bisect probe trace. */
  readonly checked: string[][] = [];
  private readonly failSpecs = new Set<string>();
  private readonly conflictSpecs = new Set<string>();
  /** Specs that report a BASE conflict (a single PR dirty against `default_branch`). */
  private readonly baseConflictSpecs = new Set<string>();
  private readonly pendingSpecs = new Set<string>();
  private throwAlways: unknown;
  private throwRemaining = 0;
  private throwOnce: unknown;
  /** When set, a pending verdict carries this `settleAfterMs` (the no-checks settle). */
  private pendingSettleAfterMs: number | undefined;

  failWhenContains(specId: string): void {
    this.failSpecs.add(specId);
  }
  conflictWhenContains(specId: string): void {
    this.conflictSpecs.add(specId);
  }
  /**
   * Report a BASE conflict (a single PR dirty against `default_branch`) when the checked
   * set contains `specId` — the verdict carries `conflictsWithBase: true` and names
   * `specId` as the culprit. The coordinator drives this through the per-run resolver
   * (driveMerge), NOT bisect/dequeue. Distinct from `conflictWhenContains` (a spec-vs-spec
   * conflict that still bisects).
   */
  baseConflictWhenContains(specId: string): void {
    this.baseConflictSpecs.add(specId);
  }
  pendingWhenContains(specId: string): void {
    this.pendingSpecs.add(specId);
  }
  /**
   * Make a pending verdict carry a `settleAfterMs` (the no-checks settle remainder) so a
   * test can assert the coordinator wakes EXACTLY at settle expiry (Bug B). Pair with
   * `pendingWhenContains`.
   */
  pendingSettlesAfter(ms: number): void {
    this.pendingSettleAfterMs = ms;
  }
  /** Throw `error` on EVERY checkBatch call (a persistent infra error). */
  throwInfraAlways(error: unknown): void {
    this.throwAlways = error;
  }
  /** Throw `error` on the first `count` calls then behave normally (transient infra). */
  throwInfraForFirst(error: unknown, count = 1): void {
    this.throwOnce = error;
    this.throwRemaining = count;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict> {
    const specIds = input.entries.map((e) => e.specId);
    this.checked.push([...specIds]);
    if (this.throwAlways !== undefined) {
      throw this.throwAlways;
    }
    if (this.throwRemaining > 0) {
      this.throwRemaining -= 1;
      throw this.throwOnce;
    }
    const hasPending = specIds.some((id) => this.pendingSpecs.has(id));
    if (hasPending) {
      return {
        result: "pending",
        message: `pending: ${specIds.join(",")}`,
        ...(this.pendingSettleAfterMs !== undefined && { settleAfterMs: this.pendingSettleAfterMs }),
      };
    }
    // A BASE conflict (a single PR dirty against the base) takes precedence: the verdict
    // names the culprit + flags `conflictsWithBase` so the coordinator drives it through
    // the per-run resolver rather than bisecting.
    const baseConflict = specIds.find((id) => this.baseConflictSpecs.has(id));
    if (baseConflict !== undefined) {
      return {
        result: "conflict",
        message: `base conflict on ${baseConflict}`,
        conflictsWithBase: true,
        conflictBetween: { specId: baseConflict, otherSpecId: "main" },
      };
    }
    const conflict = specIds.find((id) => this.conflictSpecs.has(id));
    if (conflict !== undefined) {
      return { result: "conflict", message: `conflict on ${conflict}`, conflictsWithBase: false };
    }
    const bad = specIds.find((id) => this.failSpecs.has(id));
    if (bad !== undefined) {
      return { result: "fail", message: `bad interaction with ${bad}` };
    }
    return { result: "pass", integrationBranch: `tanren/batch/${specIds.at(-1) ?? "base"}` };
  }
}

/** A recording batch-event emitter — captures every merge.batch.* event. */
export class RecordingBatchMergeEventEmitter implements BatchMergeEventEmitter {
  readonly events: Array<{
    type: "checking" | "passed" | "bisecting" | "culprit" | "infra_blocked";
    specIds?: string[];
    culpritSpecId?: string;
    capped?: boolean;
    eligibleCount?: number;
    maxBatchSize?: number;
    checks?: number;
    message?: string;
    attempts?: number;
    terminal?: boolean;
    consecutiveHolds?: number;
    kind?: "missing_required_credential" | "ambiguous_merge_state";
  }> = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitChecking(input: {
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void> {
    this.events.push({
      type: "checking",
      specIds: input.batch.map((e) => e.specId),
      capped: input.formation.capped,
      eligibleCount: input.formation.eligibleCount,
      maxBatchSize: input.maxBatchSize,
    });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitPassed(input: { batch: ReadonlyArray<MergeQueueEntry> }): Promise<void> {
    this.events.push({ type: "passed", specIds: input.batch.map((e) => e.specId) });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitBisecting(input: { batch: ReadonlyArray<MergeQueueEntry> }): Promise<void> {
    this.events.push({ type: "bisecting", specIds: input.batch.map((e) => e.specId) });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitCulprit(input: { culprit: MergeQueueEntry; checks: number }): Promise<void> {
    this.events.push({ type: "culprit", culpritSpecId: input.culprit.specId, checks: input.checks });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitInfraBlocked(input: {
    batch: ReadonlyArray<MergeQueueEntry>;
    message: string;
    attempts: number;
    terminal?: boolean;
    consecutiveHolds?: number;
    kind?: "missing_required_credential" | "ambiguous_merge_state";
  }): Promise<void> {
    this.events.push({
      type: "infra_blocked",
      specIds: input.batch.map((e) => e.specId),
      message: input.message,
      attempts: input.attempts,
      ...(input.terminal !== undefined && { terminal: input.terminal }),
      ...(input.consecutiveHolds !== undefined && { consecutiveHolds: input.consecutiveHolds }),
      ...(input.kind !== undefined && { kind: input.kind }),
    });
  }
}
