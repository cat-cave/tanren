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
 */
export class InMemoryBatchChecker implements BatchChecker {
  /** Every entry-set checked, in order (the spec-id lists) — the bisect probe trace. */
  readonly checked: string[][] = [];
  private readonly failSpecs = new Set<string>();
  private readonly conflictSpecs = new Set<string>();
  private readonly pendingSpecs = new Set<string>();

  failWhenContains(specId: string): void {
    this.failSpecs.add(specId);
  }
  conflictWhenContains(specId: string): void {
    this.conflictSpecs.add(specId);
  }
  pendingWhenContains(specId: string): void {
    this.pendingSpecs.add(specId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict> {
    const specIds = input.entries.map((e) => e.specId);
    this.checked.push([...specIds]);
    const hasPending = specIds.some((id) => this.pendingSpecs.has(id));
    if (hasPending) {
      return { result: "pending", message: `pending: ${specIds.join(",")}` };
    }
    const conflict = specIds.find((id) => this.conflictSpecs.has(id));
    if (conflict !== undefined) {
      return { result: "conflict", message: `conflict on ${conflict}` };
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
    type: "checking" | "passed" | "bisecting" | "culprit";
    specIds?: string[];
    culpritSpecId?: string;
    capped?: boolean;
    eligibleCount?: number;
    maxBatchSize?: number;
    checks?: number;
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
}
