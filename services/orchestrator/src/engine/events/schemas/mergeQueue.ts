import { z } from "zod";
import { MergeIntegrationMode } from "./integrations.js";

// P2d (autonomy-engine.md §2d): the native intelligent merge queue. Under
// `native_queue`, a ready-to-merge run ENTERS Tanren's own queue instead of
// merging immediately; the MergeCoordinator then orders ready runs in DAG order
// (ancestor before dependent, priority within a layer) and SERIALIZES their merges
// (one at a time), driving the SAME per-run merge path. These events make the
// queue's decisions visible + feed queue/stack statistics.
//
//   - merge.queue.advanced  → the coordinator selected the next run to merge (the
//                             head of the DAG-ordered queue) and is driving its
//                             merge. Carries the queue depth + the chosen run's spec
//                             so the timeline shows WHY it was next.
//   - merge.dequeued        → a queue entry left the queue WITHOUT merging: it was
//                             routed back (conflict → recoverable hold) or removed
//                             so independent later items can proceed (liveness). The
//                             `reason` records which. NOT a merge — a dequeue.
//
// (merge.queued — the entry event — reuses MergeQueuedPayload with the
// `native_queue` integration; merge.completed reuses MergeCompletedPayload.)

export const MergeQueueAdvancedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose run the coordinator selected as the queue head this pass. */
    specId: z.string(),
    /** The queue depth (ready entries) at selection time, for queue statistics. */
    queueDepth: z.number().int().nonnegative(),
  })
  .strict();

export const MergeDequeuedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose entry left the queue. */
    specId: z.string(),
    /**
     * Why the entry was dequeued without merging:
     *   - `conflict`  — the merge hit a real conflict and was routed to the P2b
     *                   resolver / recoverable hold (re-queued on the next signal).
     *   - `blocked`   — a governance/posture or speculative hold removed it from the
     *                   head so independent later items can proceed (re-queued later).
     *   - `failed`    — the merge failed terminally; the entry is removed.
     *   - `superseded`— a fresh percolation re-execution replaced this run; its entry
     *                   + PR are no longer a live merge candidate (§2c). NOT a real
     *                   conflict — the entry is retired so the spec has ONE live run.
     */
    reason: z.enum(["conflict", "blocked", "failed", "superseded"]),
    /** The human-readable detail of the dequeue (the merge-stage message). */
    message: z.string(),
  })
  .strict();

// GitHub-5xx resilience (GAP #2d): a transient/transport INFRA error (a 5xx/timeout)
// blocked the per-PR coordinator's merge DRIVE — distinct from the recoverable
// conflict/blocked dequeue. The coordinator HOLDS the entry (it stays queued) + arms a
// delayed re-drive, bounded by a hold-attempt ceiling. This LOUD event fires when the
// hold can no longer recover on its own and operator attention is warranted:
//   - `kind: "ceiling"`     → the entry exhausted its consecutive infra re-drives (a
//                             persistent outage / a logic-bug-masquerading-as-infra);
//                             the entry is removed so it cannot loop forever.
//   - `kind: "ambiguous"`   → the merge PUT hit a 5xx and the merged state could NOT be
//                             confirmed; auto-re-driving could double-merge, so the
//                             coordinator HALTS without re-PUTting (operator decides).
// It exists so a persistent infra error / an unconfirmable merge surfaces loudly instead
// of silently re-driving forever OR risking a double-merge.
export const MergeQueueInfraBlockedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose entry the infra error blocked. */
    specId: z.string(),
    /** Which loud-halt case fired (a ceiling exhaustion vs an unconfirmable merge). */
    kind: z.enum(["ceiling", "ambiguous"]),
    /** How many consecutive infra re-drives were attempted before the loud halt. */
    attempts: z.number().int().nonnegative(),
    /** The human-readable detail of the infra error / ambiguity. */
    message: z.string(),
  })
  .strict();

// P2d-2 (autonomy-engine.md §2d — speculative batch-check + bisect): the
// intelligence layer ON TOP OF the native queue. The coordinator forms a BATCH of
// mutually-eligible entries, speculatively integrates `default_branch + batch PRs`,
// and CI-checks that PROSPECTIVE merged state BEFORE any real merge — catching a bad
// *interaction* (PRs that pass alone but break together) without touching `main`. On
// a failed batch it BISECTS to isolate the offending PR (rather than failing the
// whole batch), removes it, and re-checks the innocent remainder.
//
//   - merge.batch.checking  → the coordinator formed a batch + is speculatively
//                             integrating + CI-checking the prospective merged state.
//   - merge.batch.passed    → the batch check is GREEN; the coordinator will merge
//                             every batch entry in DAG order (no re-surprises).
//   - merge.batch.bisecting → the batch check FAILED; the coordinator is binary-
//                             searching the batch to isolate the offending PR.
//   - merge.batch.culprit   → bisect isolated the single offending PR; it is dequeued
//                             to a RECOVERABLE outcome (routed to re-execution, NOT
//                             dropped) + the innocent remainder is re-checked.

/** The batch member shape echoed on the batch events (the PRs in the batch). */
const BatchMember = z
  .object({
    specId: z.string(),
    prNumber: z.number().int(),
  })
  .strict();

export const MergeBatchCheckingPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The entries in the formed batch, in DAG (merge) order. */
    members: z.array(BatchMember),
    /** The total eligible count this pass (≥ members.length when the batch was capped). */
    eligibleCount: z.number().int().nonnegative(),
    /** True when more entries were eligible than the configured cap (the batch was capped). */
    capped: z.boolean(),
    /** The configured max batch size (the cap). */
    maxBatchSize: z.number().int().positive(),
  })
  .strict();

export const MergeBatchPassedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The validated batch members the coordinator will now merge in DAG order. */
    members: z.array(BatchMember),
    /** The ephemeral integration ref the prospective merged state was checked on. */
    integrationBranch: z.string(),
  })
  .strict();

export const MergeBatchBisectingPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The failed batch being bisected, in DAG order. */
    members: z.array(BatchMember),
    /** The human-readable detail of the batch-check failure that triggered the bisect. */
    message: z.string(),
  })
  .strict();

// merge.batch.infra_blocked → the batch check could NOT be run/set up at all: a
// transient/transport INFRA error (e.g. the speculative integration ref reset threw an
// HTTP 422). This is NOT a CI failure and NOT a merge conflict — so NO PR is bisected,
// blamed, or dequeued. The coordinator bounded-retried the SAME batch and, on
// exhaustion, emits this LOUD event + HOLDS (entries stay queued, recovered on a
// delayed re-drive). It exists so a persistent infra error surfaces loudly instead of
// silently retrying forever OR wrongly dequeuing a clean PR.
export const MergeBatchInfraBlockedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The held batch members (still queued — NONE dequeued), in DAG order. */
    members: z.array(BatchMember),
    /** The human-readable detail of the infra error that blocked the check. */
    message: z.string(),
    /** How many check attempts were made before holding (the exhausted retry budget). */
    attempts: z.number().int().nonnegative(),
  })
  .strict();

export const MergeBatchCulpritPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The spec whose PR bisect isolated as the offending interaction. */
    specId: z.string(),
    /** The run id of the culprit (routed to the recoverable re-execution dequeue). */
    runId: z.string(),
    prNumber: z.number().int(),
    /** The number of speculative sub-batch checks the bisect performed (O(log n)). */
    checks: z.number().int().nonnegative(),
    /** The human-readable detail (the offending interaction). */
    message: z.string(),
  })
  .strict();
