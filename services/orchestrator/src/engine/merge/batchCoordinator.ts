// Production BatchMergeCoordinator (autonomy-engine.md §2d): batch-check + bisect over the native queue.
import {
  type BatchCheckVerdict,
  type BatchChecker,
  type BatchFormation,
  bisectCulprit,
  DEFAULT_MAX_BATCH_SIZE,
  formBatch,
} from "../contracts/batchMergeCoordinator.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../credentials/githubTokenResolver.js";
import {
  type CoordinateResult,
  type MergeCoordinator,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
} from "../contracts/mergeCoordinator.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";
import { setTimeout as sleepFor } from "node:timers/promises";
import { markDequeuedAfterEvent, type MergeQueueEventEmitter, type MergeSettleTransaction } from "./coordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import {
  driveBaseConflict,
  type BatchDriveInfraHold,
  holdOnRetriableDriveThrow,
  settleDriveOutcome,
} from "./batchCoordinatorSettle.js";
import { BatchInfraHoldCeiling, holdOnInfra, terminalInfraBlock } from "./batchInfraHoldCeiling.js";
import { RecoverableDriveHoldCeiling } from "./recoverableDriveHold.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";

const MAX_INFRA_RETRIES = 2;
const INFRA_RETRY_BACKOFF_MS = [250, 500];

const PENDING_RECHECK_MS = 15_000;

class BatchCheckStillPendingError extends Error {}

/**
 * Thrown by the bisect callback when a sub-batch's check could not be RUN (a transient
 * INFRA error from `checkEntries`). Bisect cannot name a culprit from a sub-check that
 * never ran — so the pass aborts the bisect + HOLDS (it never blames an innocent PR for
 * an infra error). Mirrors {@link BatchCheckStillPendingError}; carries the message +
 * the retriable flag so the outer pass surfaces the loud infra hold.
 */
class BatchCheckInfraError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly kind?: "missing_required_credential",
  ) {
    super(message);
  }
}

/** The batch-level events the coordinator emits (the batch-layer visibility surface). */
export interface BatchMergeEventEmitter {
  /** merge.batch.checking: a batch was formed + is being speculatively integrated + checked. */
  emitChecking(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void>;
  /** merge.batch.passed: the batch check is green; the entries will merge in DAG order. */
  emitPassed(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    integrationBranch: string;
  }): Promise<void>;
  /** merge.batch.bisecting: the batch check failed; the coordinator is isolating the culprit. */
  emitBisecting(input: { projectId: string; batch: ReadonlyArray<MergeQueueEntry>; message: string }): Promise<void>;
  /** merge.batch.culprit: bisect isolated the single offending PR (dequeued, recoverable). */
  emitCulprit(input: { projectId: string; culprit: MergeQueueEntry; checks: number; message: string }): Promise<void>;
  /** merge.batch.infra_blocked: recoverable infra hold or terminal loud halt. */
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

export interface BatchMergeCoordinatorDeps {
  queue: MergeQueueModel;
  runner: MergeRunner;
  checker: BatchChecker;
  /** The base queue-event emitter (merge.queue.advanced / merge.dequeued — reused). */
  events: MergeQueueEventEmitter;
  /** The batch-level event emitter (merge.batch.*). */
  batchEvents: BatchMergeEventEmitter;
  /**
   * The NON-BRICKING conflict-escalation seam (§2c), reused VERBATIM from the native queue
   * coordinator: parks a GENUINELY irreconcilable spec at `needs_attention` (frees its
   * slot) when the real drive returns the `needs_attention` outcome. The same helper
   * both paths use, so they can never diverge.
   */
  escalator: SpecEscalator;
  /** ATOMICITY (audit RC-4 #3): when wired, the dequeue settle runs its event append + queue UPDATE in ONE transaction (both-or-neither). */
  tx?: MergeSettleTransaction;
  recoverableDriveHolds?: RecoverableDriveHoldCeiling;
  /**
   * Resolve the per-project max batch size (the config knob). Defaults to a constant
   * `DEFAULT_MAX_BATCH_SIZE` resolver when omitted (tests inject a fixed value). The
   * production assembly resolves `projects.config.maxBatchSize` under RLS.
   */
  resolveMaxBatchSize?: (projectId: string) => Promise<number>;
  /**
   * Test seam: the sleep between infra-error re-checks. Defaults to a real timer; a
   * test injects a no-op/recording sleep so the bounded retries run instantly.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The production BatchMergeCoordinator. Adds the speculative batch-check + bisect on
 * top of the native queue's one-at-a-time drive. It reloads the queue every pass (DAG state is
 * the source of truth, never cached). It performs the REAL merges through the SAME
 * runner/model, so the native queue's ordering + serialization + lease/recovery guarantees
 * hold unchanged; the only addition is that the batch is PROVEN green as a combined
 * unit before any of it merges, and a bad interaction is isolated to one PR via bisect.
 */
export class BatchMergeCoordinator implements MergeCoordinator {
  private readonly resolveMaxBatchSize: (projectId: string) => Promise<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * GAP #1 (runaway guard): the per-project CROSS-PASS consecutive-infra-hold ceiling.
   * Each delayed re-drive is a fresh `coordinate` pass; without a cross-pass counter a
   * persistent outage re-drove the 3s timer forever. This bounds it to a loud alert with
   * slower autonomous re-drive.
   */
  private readonly infraHolds = new BatchInfraHoldCeiling();

  constructor(private readonly deps: BatchMergeCoordinatorDeps) {
    this.resolveMaxBatchSize = deps.resolveMaxBatchSize ?? (() => Promise.resolve(DEFAULT_MAX_BATCH_SIZE));
    this.sleep = deps.sleep ?? ((ms) => sleepFor(ms));
    this.deps.recoverableDriveHolds ??= new RecoverableDriveHoldCeiling();
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // Crash recovery first; the lease is the same native-queue mechanism.
    await this.deps.queue.recoverStaleClaims(projectId);
    await this.deps.queue.recoverDequeuedCandidates(projectId);

    const maxBatchSize = await this.resolveMaxBatchSize(projectId);
    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const queueDepth = snapshot.entries.length;

    // Form the batch from the CURRENT snapshot (a merge already in flight ⇒ empty
    // batch: the native queue's serialization lock dominates and we hold this pass).
    const formation = formBatch(snapshot, maxBatchSize);
    if (formation.batch.length === 0) {
      const holdReason = snapshot.mergingInFlight
        ? "serialized"
        : snapshot.entries.length === 0
          ? "empty"
          : "all_blocked";
      // A non-infra hold (serialized/empty/all_blocked) ends any infra-hold streak.
      this.infraHolds.reset(projectId);
      const retryAfterMs = holdReason === "serialized" ? serializedRetryAfterMs(snapshot) : undefined;
      return { projectId, holdReason, queueDepth, ...(retryAfterMs !== undefined && { retryAfterMs }) };
    }

    // Run the batch through check → (pass: merge all | fail: bisect + re-check). The
    // recursion re-forms the batch WITHOUT the culprit each fail, so the innocent PRs
    // still merge; it terminates because each bisect strictly removes one entry.
    return this.processBatch(projectId, formation, queueDepth, maxBatchSize);
  }

  /**
   * Speculatively check the formed batch, then either drive every entry's real merge
   * (on pass) or isolate + dequeue the offending PR and re-check the remainder (on
   * fail). `formation` is the already-formed batch for THIS attempt; on a fail we
   * re-FORM (reload the snapshot) without the culprit so a newly-eligible entry can
   * join and the cap is re-applied. Bounded: each fail removes exactly one entry, so
   * the loop runs at most `batch.length` times.
   */
  private async processBatch(
    projectId: string,
    formation: BatchFormation,
    queueDepth: number,
    maxBatchSize: number,
  ): Promise<CoordinateResult> {
    let current = formation;
    // Specs already bisected-out this pass — excluded from the re-formed batch so a
    // re-form never re-includes a known culprit (the loop strictly shrinks).
    const excludedSpecIds = new Set<string>();

    // The loop bound: at most one entry is removed per iteration, so it cannot exceed
    // the initial batch size + 1 (the final all-clear merge). A hard ceiling guards
    // against any logic error ever spinning.
    const maxIterations = formation.eligibleCount + 1;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (current.batch.length === 0) {
        // Everything eligible was bisected out (all-culprits) — nothing to merge; the
        // dequeued culprits re-enter via re-execution later. Progress, not an infra
        // error — clear the streak.
        this.infraHolds.reset(projectId);
        return { projectId, holdReason: "all_blocked", queueDepth };
      }

      if (current.capped) {
        // The cap LOG (operator visibility — never a SILENT truncation): more eligible
        // entries than the batch size; the remainder keeps its position for next pass.
        console.info(
          `[batch-coordinator] project ${projectId}: batch CAPPED to ${current.batch.length} of ${current.eligibleCount} eligible (maxBatchSize=${maxBatchSize}); the remainder is re-considered next pass`,
        );
      }
      const checked = await this.checkBatchWithInfraRetry(projectId, current, maxBatchSize);
      if (checked.kind === "infra-terminal") {
        return this.terminalInfraBlock(projectId, current.batch, checked.message, queueDepth, checked.cause);
      }
      if (checked.kind === "infra-exhausted") {
        return this.infraHold(projectId, current.batch, checked.message, queueDepth);
      }
      const verdict = checked.verdict;

      if (verdict.result === "pass") {
        const { integrationBranch } = verdict;
        await this.deps.batchEvents.emitPassed({ projectId, batch: current.batch, integrationBranch });
        const result = await this.mergeBatch(projectId, current.batch, queueDepth);
        if (result.holdReason !== "infra_error" && result.holdReason !== "infra_blocked") {
          this.infraHolds.reset(projectId);
        }
        return result;
      }

      if (verdict.result === "pending") {
        this.infraHolds.reset(projectId);
        const retryAfterMs = verdict.settleAfterMs ?? PENDING_RECHECK_MS;
        return { projectId, holdReason: "all_blocked", retryAfterMs, queueDepth };
      }

      // BASE-CONFLICT SHORT-CIRCUIT: drive a dirty-vs-base PR through the per-run resolver.
      if (verdict.result === "conflict" && verdict.conflictsWithBase) {
        const result = await driveBaseConflict(this.deps, projectId, current.batch, verdict, queueDepth);
        if (!("projectId" in result)) {
          if (result.kind === "infra_terminal") {
            return this.terminalInfraBlock(projectId, [result.entry], result.message, queueDepth, result.terminalKind);
          }
          return this.infraHold(projectId, current.batch, result.message, queueDepth);
        }
        this.infraHolds.reset(projectId);
        return result;
      }

      this.infraHolds.reset(projectId);

      const failMessage = verdict.result === "conflict" ? `integration conflict: ${verdict.message}` : verdict.message;
      await this.deps.batchEvents.emitBisecting({ projectId, batch: current.batch, message: failMessage });

      const bisect = await this.bisectBatch(projectId, current.batch);
      if (bisect === "pending") {
        // A sub-batch's CI was still running — HOLD (no entry dequeued/blamed). Bug B:
        // back off with a `retryAfterMs` so the subscriber re-drives once rather than
        // re-checking on every unrelated NOTIFY (same anti-hot-loop guarantee).
        return { projectId, holdReason: "all_blocked", retryAfterMs: PENDING_RECHECK_MS, queueDepth };
      }
      if ("kind" in bisect) {
        // A sub-batch check could NOT be RUN (a transient infra error) — bisect cannot
        // name a culprit from a check that never ran. HOLD loudly (no PR blamed) via the
        // SAME cross-pass ceiling so a persistent bisect-time infra error also terminates.
        if (bisect.cause !== undefined) {
          return this.terminalInfraBlock(projectId, current.batch, bisect.message, queueDepth, bisect.cause);
        }
        return this.infraHold(projectId, current.batch, bisect.message, queueDepth);
      }

      const dequeueMessage = `bisected as the offending PR in a failed batch check: ${failMessage}`;
      const { culprit, checks } = bisect;
      await this.deps.batchEvents.emitCulprit({ projectId, culprit, checks, message: failMessage });
      // Dequeue the culprit to a RECOVERABLE outcome (conflict reason ⇒ routed to the
      // re-execution path — the run loop re-enqueues it once it re-gates clean; NEVER dropped).
      await markDequeuedAfterEvent({
        queue: this.deps.queue,
        events: this.deps.events,
        projectId,
        entry: bisect.culprit,
        reason: "conflict",
        message: dequeueMessage,
        tx: this.deps.tx,
      });
      excludedSpecIds.add(bisect.culprit.specId);

      // RE-FORM the batch WITHOUT the culprit (reload the snapshot so the dequeued culprit
      // is gone + a newly-eligible entry can join + the cap re-applies), then re-check next loop.
      const refreshed = await this.deps.queue.loadSnapshot(projectId);
      const reformed = formBatch(refreshed, maxBatchSize);
      reformed.batch = reformed.batch.filter((e) => !excludedSpecIds.has(e.specId));
      current = reformed;
    }

    // The loop bound was hit (a logic guard — unreachable since each fail removes one
    // entry). Hold rather than risk an unverified merge. Not an infra error.
    this.infraHolds.reset(projectId);
    return { projectId, holdReason: "all_blocked", queueDepth };
  }

  /** Check a formed batch, retrying only typed-retriable infra errors in-pass. */
  private async checkBatchWithInfraRetry(
    projectId: string,
    formation: BatchFormation,
    maxBatchSize: number,
  ): Promise<
    | { kind: "verdict"; verdict: BatchCheckVerdict }
    | { kind: "infra-exhausted"; message: string }
    | { kind: "infra-terminal"; message: string; cause?: "missing_required_credential" }
  > {
    let lastMessage = "batch check could not run (infra error)";
    for (let attempt = 0; attempt <= MAX_INFRA_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(INFRA_RETRY_BACKOFF_MS[attempt - 1] ?? 500);
      }
      await this.deps.batchEvents.emitChecking({ projectId, batch: formation.batch, formation, maxBatchSize });
      const verdict = await this.checkEntries(projectId, formation.batch);
      if (verdict.result !== "infra-error") {
        return { kind: "verdict", verdict };
      }
      lastMessage = verdict.message;
      // Required config cannot self-heal via timed re-drive.
      if (!verdict.retriable) return { kind: "infra-terminal", message: lastMessage, cause: verdict.kind };
    }
    return { kind: "infra-exhausted", message: lastMessage };
  }

  /** GAP #1: hold the batch on an infra error, bounded by the cross-pass ceiling. */
  private infraHold(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    message: string,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    const ceiling = this.infraHolds;
    return holdOnInfra({
      ceiling,
      queue: this.deps.queue,
      events: this.deps.batchEvents,
      projectId,
      batch,
      message,
      queueDepth,
    });
  }

  /**
   * Speculatively integrate + CI-check the given entry set (the BatchChecker assembles
   * `default_branch + the entries` and runs CI on the ephemeral integration ref — NEVER
   * touching default_branch). An empty set checks the base alone (passes — the bisect
   * lower-bound). A THROWN checker means the check could not be RUN (a transport/ref
   * infra error) — NOT a CI failure and NEVER a PR's fault, so we return the
   * `infra-error` verdict (NOT `fail`); the caller bounded-retries then HOLDS loudly,
   * never dequeuing a clean PR. `retriable` derives from the typed provider error.
   */
  private async checkEntries(projectId: string, entries: ReadonlyArray<MergeQueueEntry>): Promise<BatchCheckVerdict> {
    try {
      return await this.deps.checker.checkBatch({ projectId, entries });
    } catch (error) {
      return {
        result: "infra-error",
        message: `batch check threw: ${String(error)}`,
        retriable: isRetriableInfraError(error),
        ...(isMissingGithubCredentialError(error) ? { kind: "missing_required_credential" as const } : {}),
      };
    }
  }

  /**
   * Binary-search the failed batch to isolate the single offending PR (the pure
   * `bisectCulprit` driver over `checkEntries`). Returns the bisect result on a
   * definitive pass→fail boundary; `"pending"` when a sub-batch's CI was still running
   * (HOLD, never guess); `{kind:"infra", message}` when a sub-batch check could NOT be
   * RUN — bisect MUST NOT name a culprit from a check that never ran, so the pass aborts
   * the bisect + HOLDS loudly. Each sub-batch check is a speculative integration +
   * CI-check on a PREFIX; the pure driver terminates + names exactly the boundary.
   */
  private async bisectBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
  ): Promise<
    | Awaited<ReturnType<typeof bisectCulprit>>
    | "pending"
    | { kind: "infra"; message: string; cause?: "missing_required_credential" }
  > {
    try {
      return await bisectCulprit(batch, async (prefixLength) => {
        const v = await this.checkEntries(projectId, batch.slice(0, prefixLength));
        if (v.result === "pending") {
          throw new BatchCheckStillPendingError(`sub-batch CI still pending (prefix length ${prefixLength})`);
        }
        if (v.result === "infra-error") {
          throw new BatchCheckInfraError(
            `sub-batch check could not run (prefix length ${prefixLength}): ${v.message}`,
            v.retriable,
            v.kind,
          );
        }
        return v.result === "pass" ? "pass" : "fail";
      });
    } catch (error) {
      if (error instanceof BatchCheckStillPendingError) return "pending";
      if (error instanceof BatchCheckInfraError) {
        if (error.kind === undefined) return { kind: "infra", message: error.message };
        return { kind: "infra", message: error.message, cause: error.kind };
      }
      throw error;
    }
  }

  private async mergeBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    let mergedSpecId: string | undefined;
    let dequeuedSpecId: string | undefined;
    for (const entry of batch) {
      const claimed = await this.deps.queue.claim(entry.queueId);
      if (!claimed) {
        // The winning pass may die; arm a lease-bound serialized retry.
        const refreshed = await this.deps.queue.loadSnapshot(projectId);
        return {
          projectId,
          queueDepth,
          holdReason: "serialized",
          retryAfterMs: serializedRetryAfterMs(refreshed),
          ...(mergedSpecId !== undefined && { mergedSpecId }),
        };
      }
      await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

      const outcome = await this.driveOne(projectId, entry);
      if (outcome.kind === "infra_hold") {
        return this.infraHold(projectId, batch, outcome.message, queueDepth);
      }
      if (outcome.kind === "infra_terminal") {
        return this.terminalInfraBlock(projectId, [outcome.entry], outcome.message, queueDepth, outcome.terminalKind);
      }
      if (outcome.kind === "merged") {
        this.deps.recoverableDriveHolds?.reset(entry.queueId);
        await this.deps.queue.markMerged(entry.queueId);
        mergedSpecId = entry.specId;
        continue;
      }

      const settled = await settleDriveOutcome(this.deps, projectId, entry, outcome);
      if (settled !== "dequeued") {
        return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: settled.retryAfterMs };
      }
      dequeuedSpecId = entry.specId;
      break;
    }
    return {
      projectId,
      queueDepth,
      ...(mergedSpecId !== undefined && { mergedSpecId }),
      ...(dequeuedSpecId !== undefined && { dequeuedSpecId }),
    };
  }

  private async driveOne(projectId: string, entry: MergeQueueEntry): Promise<MergeDriveOutcome | BatchDriveInfraHold> {
    try {
      return await this.deps.runner.driveMerge({ runId: entry.runId, projectId });
    } catch (error) {
      const hold = await holdOnRetriableDriveThrow(this.deps, projectId, entry, error);
      if (hold !== undefined) return hold;
      return { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }
  }

  private async terminalInfraBlock(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    message: string,
    queueDepth: number,
    kind?: "missing_required_credential" | "ambiguous_merge_state",
  ): Promise<CoordinateResult> {
    this.infraHolds.reset(projectId);
    const input = {
      queue: this.deps.queue,
      events: this.deps.batchEvents,
      projectId,
      batch,
      message,
      queueDepth,
    };
    if (kind === undefined) return terminalInfraBlock(input);
    return terminalInfraBlock({ ...input, kind });
  }
}

function isMissingGithubCredentialError(error: unknown): boolean {
  return error instanceof MissingGithubCredentialRefError || error instanceof NoGithubCredentialConfiguredError;
}
