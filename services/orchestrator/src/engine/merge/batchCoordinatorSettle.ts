// The non-merged drive-outcome SETTLE mapping for the BatchMergeCoordinator,
// split from `batchCoordinator.ts` to keep that file under the 500-line cap. It is the
// SAME settle policy the EventEmittingMergeCoordinator applies, so the two
// coordinators can never diverge on how a real-merge outcome leaves the queue:
//   - `needs_attention` → the NON-BRICKING conflict escalation (§2c): PARK the spec at
//     `needs_attention` (frees its slot) via the shared `SpecEscalator`, then dequeue
//     the entry `needs_attention` (NEVER re-queued). NOT the recoverable conflict path.
//   - `blocked` → bounded recoverable hold: release the claim so the same candidate
//     re-drives with backoff, then alert and continue on a slower retry at the ceiling.
//   - `conflict` → dequeue only after the per-run resolver has routed a re-plan owner.
//   - `failed` → ordinary merge callers retain their native failure settlement, while
//     `driveConflictCulprit` intercepts it and assigns writer-rework or needs_attention
//     ownership before retiring the stale entry.
//
// `merged` is handled inline by the caller (it advances rather than settling out), so
// this maps only the NON-merged outcomes.

import type { BatchCheckVerdict, BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type {
  CoordinateResult,
  MergeDriveOutcome,
  MergeQueueEntry,
  MergeQueueModel,
  MergeRunner,
} from "../contracts/mergeCoordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";
import { isAmbiguousMergeError } from "../providers/mergeOutcomeErrors.js";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter, type MergeSettleTransaction } from "./coordinator.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";
import {
  holdOrHaltRecoverableDrive,
  type RecoverableDriveHoldCeiling,
  type RecoverableDriveHoldResult,
} from "./recoverableDriveHold.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-coordinator");

/** How long after a transient batch drive throw the subscriber re-drives the project. */
export const BATCH_DRIVE_INFRA_RETRY_AFTER_MS = 3000;

export type BatchDriveInfraHold =
  | { kind: "infra_hold"; message: string; retryAfterMs: number; entry: MergeQueueEntry }
  | { kind: "infra_terminal"; message: string; entry: MergeQueueEntry; terminalKind: "ambiguous_merge_state" };

/** The slice of the batch coordinator's deps the settle mapping needs. */
export interface BatchSettleDeps {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  escalator: SpecEscalator;
  /** The batch-gate-fail writer-rework router (v35 — the strand fix; see {@link settleBisectCulprit}). */
  gateRework?: BatchGateReworkRouter;
  /** ATOMICITY (audit RC-4 #3): when wired, the dequeue settle runs event + UPDATE in one transaction. */
  tx?: MergeSettleTransaction;
  recoverableDriveHolds?: RecoverableDriveHoldCeiling;
}

/**
 * Settle a bisected culprit by its failure sub-kind (v35 — the gate-fail-strand fix):
 *
 *   - GATE-FAIL (`isGateFail`) — the integrated tree's GATE/CI failed (the culprit's work
 *     passed its OWN branch gates but breaks integrated). Route it to the WRITER for rework
 *     via the {@link BatchGateReworkRouter}, carrying the batch gate's failing output
 *     (`gateError`) as steering so the writer fixes the RIGHT thing (no_silent_fallback —
 *     never rework blind). The router enqueues a fresh re-author run (bounded — it escalates
 *     to `needs_attention` past the rework budget). EITHER way the OLD queue entry is retired
 *     as `superseded` (the re-authored run produces a fresh entry, so the old one is no
 *     longer a live candidate — and `superseded` is NOT routed through
 *     `recoverDequeuedCandidates`, so it cannot resurrect the dead head). This is the path
 *     the old code MISSED: it dequeued a gate-fail culprit with `reason: "conflict"`, which
 *     has NO re-execution consumer (the recovery SQL only re-queues `blocked`), so the spec
 *     sat `in_flight` forever.
 * A spec-vs-spec CONFLICT culprit is NO LONGER settled here — the caller now DRIVES it through
 * the per-run resolver ({@link driveConflictCulprit}) so the work survives + is rebased/resolved
 * in place, then classifies the drive outcome. `settleBisectCulprit` is therefore invoked ONLY
 * for a GATE-FAIL culprit. (The `conflict`-dequeue fallback below survives solely for a
 * degenerate no-router assembly where a gate-fail cannot reach the writer; production always
 * wires the router.)
 */
export async function settleBisectCulprit(
  deps: BatchSettleDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  isGateFail: boolean,
  gateError: string,
  failMessage: string,
): Promise<void> {
  if (isGateFail && deps.gateRework !== undefined) {
    // The WRITER rework path: re-author the culprit to fix the integration-only gate
    // failure, then retire the OLD entry (the re-authored run re-queues a fresh one).
    await deps.gateRework.routeGateFailToRework({ projectId, culprit, gateError });
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry: culprit,
      reason: "superseded",
      message: `routed to writer rework after a failed integrated-tree gate: ${failMessage}`,
      tx: deps.tx,
    });
    return;
  }
  // Degenerate no-router fallback ONLY: a gate-fail culprit that cannot reach the writer
  // (production always wires the router). A spec-vs-spec conflict never reaches here — the
  // caller drives it through the resolver (`driveConflictCulprit`) instead of dequeuing.
  await markDequeuedAfterEvent({
    queue: deps.queue,
    events: deps.events,
    projectId,
    entry: culprit,
    reason: "conflict",
    message: `bisected as the offending PR in a failed batch check: ${failMessage}`,
    tx: deps.tx,
  });
}

/** The slice of deps the base-conflict drive needs (settle deps + the merge runner). */
export interface BatchBaseConflictDeps extends BatchSettleDeps {
  runner: MergeRunner;
}

export async function holdOnRetriableDriveThrow(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  error: unknown,
): Promise<BatchDriveInfraHold | undefined> {
  if (isAmbiguousMergeError(error)) {
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return {
      kind: "infra_terminal",
      message: `merge drive state ambiguous; auto-retry could double-merge: ${String(error)}`,
      entry,
      terminalKind: "ambiguous_merge_state",
    };
  }
  if (!isRetriableInfraError(error)) return undefined;
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  await deps.queue.releaseClaim(entry.queueId);
  log.warn(
    "merge drive threw a transient infra error; holding + re-driving (entry stays queued)",
    {
      projectId,
      specId: entry.specId,
    },
    error,
  );
  return {
    kind: "infra_hold",
    message: `merge drive threw transient infra error: ${String(error)}`,
    retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS,
    entry,
  };
}

/**
 * Settle a NON-merged real-merge outcome for one batch entry. A `needs_attention`
 * outcome parks the spec (frees its slot) + dequeues `needs_attention`; any other
 * outcome follows the same bounded recoverable-hold / terminal conflict-dequeue policy as
 * `EventEmittingMergeCoordinator.driveAndSettle`.
 */
export async function settleDriveOutcome(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  outcome: Exclude<MergeDriveOutcome, { kind: "merged" }>,
): Promise<"dequeued" | RecoverableDriveHoldResult> {
  if (outcome.kind === "needs_attention") {
    // The LOUD TERMINAL ESCALATION (§2c — non-bricking): park the spec FIRST (frees its
    // slot — the rest of the DAG keeps moving), then dequeue `needs_attention` (NEVER
    // re-queued). The escalator emits `dag.spec.needs_attention`; the dequeue emits
    // `merge.dequeued`. NOT the recoverable conflict path (it would re-conflict forever).
    await deps.escalator.escalate({ projectId, entry, message: outcome.message });
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry,
      reason: "needs_attention",
      message: outcome.message,
      tx: deps.tx,
    });
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    return "dequeued";
  }

  if (outcome.kind === "re_gate_pending") {
    // The post-auto-rebase native re-gate is NOT YET TERMINAL (still running / infra blip):
    // re-drivable, "not done yet" — RELEASE the claim so the entry STAYS QUEUED + arm a paced
    // re-drive (the gate just needs to finish). NEVER dequeued (the old `conflict` mapping
    // bricked the live DAG) and NO fixed attempt cap (a still-running gate is not non-
    // convergence). A genuinely-stuck gate surfaces via the thrown-infra halts / a terminal
    // failed/needs_attention verdict, not a count on this hold.
    await deps.recoverableDriveHolds?.reset(entry.queueId);
    await deps.queue.releaseClaim(entry.queueId);
    return { kind: "held", retryAfterMs: BATCH_DRIVE_INFRA_RETRY_AFTER_MS };
  }

  if (outcome.kind === "blocked") {
    const ceiling = deps.recoverableDriveHolds;
    if (ceiling !== undefined) {
      return holdOrHaltRecoverableDrive({ ceiling, queue: deps.queue, events: deps.events, projectId, entry, outcome });
    }
  }

  const reason = outcome.kind;
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  await markDequeuedAfterEvent({
    queue: deps.queue,
    events: deps.events,
    projectId,
    entry,
    reason,
    message: outcome.message,
    tx: deps.tx,
  });
  return "dequeued";
}

/**
 * Drive a BASE-CONFLICT culprit (a single PR dirty against `default_branch`, the verdict
 * carrying `conflictsWithBase: true`) through the EXISTING real per-run merge path — the
 * SAME `runner.driveMerge` the merge step uses. The drive's `ensureUpToDate` rebases the
 * PR onto base, runs the intent-preserving resolver, re-gates, re-pushes, and classifies
 * resolve-vs-replan-vs-escalate. This is the path the batch coordinator previously
 * STARVED by dequeuing the PR first; routing the culprit here is the fix.
 *
 * The culprit is the entry whose spec matches `verdict.conflictBetween.specId`. We CLAIM
 * it first (the SAME serialization lease the merge step takes) so a concurrent pass can't
 * double-drive it, then drive + settle from the outcome via {@link settleDriveOutcome}:
 * `merged` advances (markMerged); recoverable `blocked` holds with backoff;
 * `conflict` dequeues after resolver-owned replan; `failed` routes to writer rework;
 * `needs_attention` parks the spec (frees its slot, never re-queued).
 */
export async function driveBaseConflict(
  deps: BatchBaseConflictDeps,
  projectId: string,
  batch: ReadonlyArray<MergeQueueEntry>,
  verdict: Extract<BatchCheckVerdict, { result: "conflict" }>,
  queueDepth: number,
): Promise<CoordinateResult | BatchDriveInfraHold> {
  const culpritSpecId = verdict.conflictBetween?.specId;
  const culprit = batch.find((e) => e.specId === culpritSpecId);
  if (culprit === undefined) {
    // The verdict named a base conflict but no batch entry matches the culprit spec — a
    // logic mismatch we must NOT paper over by bisecting (which would blame a PR). HOLD
    // loudly (the entries stay queued; the next pass re-forms from fresh state).
    log.warn("base-conflict verdict named a spec not in the formed batch — holding (no dequeue)", {
      projectId,
      culpritSpecId: String(culpritSpecId),
      message: verdict.message,
    });
    return { projectId, holdReason: "all_blocked", queueDepth };
  }

  // The culprit is identified from the verdict; drive it through the resolver.
  return driveConflictCulprit(deps, projectId, culprit, queueDepth);
}

/**
 * DRIVE an already-identified CONFLICT culprit through the EXISTING per-run merge path
 * (`runner.driveMerge`) + settle its outcome — the NEVER-DISCARD conflict re-drive shared by
 * BOTH the base-conflict short-circuit ({@link driveBaseConflict}) AND the spec-vs-spec
 * bisect tail. `driveMerge` rebases the culprit onto the CURRENT base (a sibling that merged
 * first is now in base), runs the intent-preserving resolver, re-gates, and CLASSIFIES the
 * outcome:
 *   - `merged`  → `markMerged` (advance);
 *   - `blocked` → bounded recoverable hold (stays queued, re-driven with backoff);
 *   - `conflict` → dequeue after the resolver-routed replan owns the surviving work;
 *   - `failed` → route to writer rework (or loud needs_attention without that router)
 *     BEFORE retiring the stale entry;
 *   - `needs_attention` → PARK the spec at `needs_attention` (the resolver's fixed-point
 *     genuine-product-clash verdict — loud, never silent, never a forever-dequeue).
 *
 * This is what a bare `markDequeued(..,"conflict")` on the bisect culprit MISSED: no resolver
 * ever ran for a dequeued spec, and `recoverDequeuedCandidates` only revives `blocked` — so a
 * spec-vs-spec bisect culprit sat `dequeued=conflict` forever, blocking every dependent. We
 * CLAIM the culprit first (the same serialization lease the merge step takes) so a concurrent
 * pass can't double-drive it; a lost claim holds serialized (another pass owns it).
 */
export async function driveConflictCulprit(
  deps: BatchBaseConflictDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  queueDepth: number,
): Promise<CoordinateResult | BatchDriveInfraHold> {
  // CLAIM first (the serialization lease — mirror the merge step) so a concurrent pass
  // can't double-drive. A lost claim means another pass is already driving it — hold.
  const claimed = await deps.queue.claim(culprit.queueId);
  if (!claimed) {
    const refreshed = await deps.queue.loadSnapshot(projectId);
    return { projectId, holdReason: "serialized", queueDepth, retryAfterMs: serializedRetryAfterMs(refreshed) };
  }
  await deps.events.emitAdvanced({ projectId, entry: culprit, queueDepth });

  const outcome = await driveOneEntry(deps, projectId, culprit);
  if (outcome.kind === "infra_hold" || outcome.kind === "infra_terminal") {
    return outcome;
  }
  if (outcome.kind === "merged") {
    await deps.queue.markMerged(culprit.queueId);
    return { projectId, queueDepth, mergedSpecId: culprit.specId };
  }
  if (outcome.kind === "failed") {
    await settleFailedConflictDrive(deps, projectId, culprit, outcome.message);
    return { projectId, queueDepth, dequeuedSpecId: culprit.specId };
  }

  // A non-merged drive outcome: settle via the SAME policy the merge step uses
  // (recoverable hold / needs_attention park). A failed fresh gate was intercepted above.
  const settled = await settleDriveOutcome(deps, projectId, culprit, outcome);
  if (settled !== "dequeued") {
    return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: settled.retryAfterMs };
  }
  return { projectId, queueDepth, dequeuedSpecId: culprit.specId };
}

/** Assign an owner to a failed post-resolution gate before the stale entry retires. */
async function settleFailedConflictDrive(
  deps: BatchSettleDeps,
  projectId: string,
  culprit: MergeQueueEntry,
  failure: string,
): Promise<void> {
  const gateError = `resolved conflict failed fresh pre_merge: ${failure}`;
  let reason: "superseded" | "needs_attention";
  let message: string;
  if (deps.gateRework === undefined) {
    reason = "needs_attention";
    message = `${gateError}; no writer-rework router is configured`;
    await deps.escalator.escalate({ projectId, entry: culprit, message });
  } else {
    const disposition = await deps.gateRework.routeGateFailToRework({ projectId, culprit, gateError });
    reason = disposition === "reworked" ? "superseded" : "needs_attention";
    message = `${gateError}; writer-rework disposition: ${disposition}`;
  }
  await markDequeuedAfterEvent({
    queue: deps.queue,
    events: deps.events,
    projectId,
    entry: culprit,
    reason,
    message,
    tx: deps.tx,
  });
  await deps.recoverableDriveHolds?.reset(culprit.queueId);
}

/** Drive ONE entry's real merge through the native-queue path; a thrown drive ⇒ recoverable blocked. */
async function driveOneEntry(
  deps: BatchBaseConflictDeps,
  projectId: string,
  entry: MergeQueueEntry,
): Promise<MergeDriveOutcome | BatchDriveInfraHold> {
  try {
    return await deps.runner.driveMerge({ runId: entry.runId, projectId });
  } catch (error) {
    const hold = await holdOnRetriableDriveThrow(deps, projectId, entry, error);
    if (hold !== undefined) return hold;
    return { kind: "blocked", message: `merge drive threw: ${String(error)}` };
  }
}
