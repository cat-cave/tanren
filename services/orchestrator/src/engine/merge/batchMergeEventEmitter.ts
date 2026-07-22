// The batch-event emitter interface (autonomy-engine.md §2d). The production
// implementation is `PgBatchMergeEventEmitter` (batchCoordinatorPg.ts); the
// coordinator consumes this seam. Extracted to its own module so the
// coordinator file stays under the 500-line source-file cap, AND so a future
// consumer (a runtime-verification subsystem, rv-16b) can depend on the
// interface WITHOUT dragging in the full coordinator.

import type { BatchFormation } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { VerdictOutcome } from "../events/schemas/runtimeVocabulary.js";

export interface BatchMergeEventEmitter {
  emitChecking(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void>;
  emitPassed(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    integrationBranch: string;
  }): Promise<void>;
  emitBisecting(input: { projectId: string; batch: ReadonlyArray<MergeQueueEntry>; message: string }): Promise<void>;
  /**
   * Emit `merge.batch.behavior_failed` (rv-25 runtime vocabulary) when a batch's
   * behavior verification fails — the failure that triggers bisection. The
   * payload carries the runtime behavior-proof coordinate
   * (`groupId` / `behaviorRevisionId` / `verdictId` / `outcome`) so downstream
   * rv consumers can correlate the batch failure with the verdict that named it.
   * The current CI/gate-only `BatchCheckVerdict` does not carry these — the
   * emit fires when behavior verification is wired (rv-16b); the producer is
   * exercised directly by `batchCoordinatorPgBisectionEvents.test.ts`.
   */
  emitBehaviorFailed(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    groupId: string;
    behaviorRevisionId: string;
    verdictId: string;
    outcome: VerdictOutcome;
  }): Promise<void>;
  /**
   * Emit `merge.batch.culprit_set_identified` (rv-25 runtime vocabulary) when
   * bisection isolates the culprit SET — the ddmin/QuickXPlain minimal failing
   * subset. `culpritMembers` is the EXACT set (carried verbatim as
   * `culpritMemberIds`); an empty set is rejected (the registered Zod schema
   * admits `min(1)`). Renamed from `emitCulprit` (singular) — the canonical
   * event name is `culprit_set_identified`, not the legacy `culprit`.
   */
  emitCulpritSetIdentified(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    groupId: string;
    culpritMembers: ReadonlyArray<MergeQueueEntry>;
  }): Promise<void>;
  emitInfraBlocked(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    message: string;
    attempts: number;
    terminal?: boolean;
    consecutiveHolds?: number;
    kind?: "missing_required_credential" | "ambiguous_merge_state";
  }): Promise<void>;
}
