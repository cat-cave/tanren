// Production BatchMergeCoordinator (autonomy-engine.md §2d): batch-check + bisect over the native queue.
import {
  type BatchCheckVerdict,
  type BatchChecker,
  type BatchFormation,
  type BatchGateReworkRouter,
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
import type { MergeQueueEventEmitter, MergeSettleTransaction } from "./coordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import {
  driveBaseConflict,
  driveConflictCulprit,
  type BatchDriveInfraHold,
  holdOnRetriableDriveThrow,
  settleBisectCulprit,
  settleDriveOutcome,
} from "./batchCoordinatorSettle.js";
import { BatchInfraHoldCeiling, holdOnInfra, terminalInfraBlock } from "./batchInfraHoldCeiling.js";
import { escalateInfraHoldToWriter } from "./batchInfraEscalate.js";
import type { HoldCeilingStore } from "./holdCeilingStore.js";
import { RecoverableDriveHoldCeiling } from "./recoverableDriveHold.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("batch-coordinator");

// The IN-PASS re-poll spacing (NOT a cap): re-poll a transient infra condition once, then hand off any recurrence to the cross-pass hold. Spin-free.
const INFRA_RETRY_BACKOFF_MS = 500;

const PENDING_RECHECK_MS = 15_000;

class BatchCheckStillPendingError extends Error {}

/**
 * Thrown by the bisect callback when a sub-batch's check could not be RUN (a transient INFRA error
 * from `checkEntries`). Bisect never blames an innocent PR for a sub-check that never ran, so the
 * pass aborts the bisect + HOLDS. Carries the message + retriable flag for the loud infra hold.
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
  /** §2c spec-escalator: parks irreconcilable specs at `needs_attention` (shared with native queue). */
  escalator: SpecEscalator;
  /**
   * Writer-rework router (v35 strand fix + v54 #56): a GATE-fail bisect culprit + a sustained infra
   * hold both route to the WRITER (`settleBisectCulprit` / `escalateInfraHoldToWriter`). Prod wires it.
   */
  gateRework?: BatchGateReworkRouter;
  /** ATOMICITY (audit RC-4 #3): when wired, the dequeue settle runs its event append + queue UPDATE in ONE transaction (both-or-neither). */
  tx?: MergeSettleTransaction;
  recoverableDriveHolds?: RecoverableDriveHoldCeiling;
  /** Audit RC-7: the DURABLE backing store for BOTH runaway-guard ceilings, so the counters survive a restart (absent → in-memory, for fakes). */
  holdCeilingStore?: HoldCeilingStore;
  /** Per-project max batch size resolver. Default → `DEFAULT_MAX_BATCH_SIZE`; prod reads `projects.config.maxBatchSize`. */
  resolveMaxBatchSize?: (projectId: string) => Promise<number>;
  /** Test seam: the sleep between infra-error re-polls. Defaults to a real timer; a test injects a no-op/recording sleep so re-polls run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Production BatchMergeCoordinator: speculative batch-check + bisect over the native queue. Reloads
 * the queue per pass; REAL merges reuse the same runner/model so ordering + lease/recovery hold.
 */
export class BatchMergeCoordinator implements MergeCoordinator {
  private readonly resolveMaxBatchSize: (projectId: string) => Promise<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  /** GAP #1 (runaway guard): the per-project CROSS-PASS consecutive-infra-hold ceiling — bounds a persistent outage to a loud alert (each re-drive is a fresh pass). */
  private readonly infraHolds: BatchInfraHoldCeiling;

  constructor(private readonly deps: BatchMergeCoordinatorDeps) {
    this.resolveMaxBatchSize = deps.resolveMaxBatchSize ?? (() => Promise.resolve(DEFAULT_MAX_BATCH_SIZE));
    this.sleep = deps.sleep ?? ((ms) => sleepFor(ms));
    // Audit RC-7: back both runaway-guard ceilings with the injected durable store (survives a restart).
    this.infraHolds = new BatchInfraHoldCeiling(deps.holdCeilingStore);
    this.deps.recoverableDriveHolds ??= new RecoverableDriveHoldCeiling(deps.holdCeilingStore);
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // Crash recovery first; the lease is the same native-queue mechanism.
    await this.deps.queue.recoverStaleClaims(projectId);
    await this.deps.queue.recoverDequeuedCandidates(projectId);

    const maxBatchSize = await this.resolveMaxBatchSize(projectId);
    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const queueDepth = snapshot.entries.length;

    // Form the batch from the CURRENT snapshot (a merge already in flight ⇒ empty batch: the native queue's serialization lock dominates, hold this pass).
    const formation = formBatch(snapshot, maxBatchSize);
    if (formation.batch.length === 0) {
      const holdReason = snapshot.mergingInFlight
        ? "serialized"
        : snapshot.entries.length === 0
          ? "empty"
          : "all_blocked";
      // A non-infra hold (serialized/empty/all_blocked) ends any infra-hold streak.
      await this.infraHolds.reset(projectId);
      const retryAfterMs = holdReason === "serialized" ? serializedRetryAfterMs(snapshot) : undefined;
      return { projectId, holdReason, queueDepth, ...(retryAfterMs !== undefined && { retryAfterMs }) };
    }

    // Run the batch through check → (pass: merge all | fail: bisect + re-check), re-forming without
    // the culprit each fail so the innocents still merge; terminates as each bisect removes one entry.
    return this.processBatch(projectId, formation, queueDepth, maxBatchSize);
  }

  /**
   * Speculatively check the formed batch, then drive every entry's merge (pass) or isolate the
   * offending PR + re-check the remainder (fail), re-forming without the culprit each fail. Each
   * fail removes one entry, so the loop runs at most `batch.length`.
   */
  private async processBatch(
    projectId: string,
    formation: BatchFormation,
    queueDepth: number,
    maxBatchSize: number,
  ): Promise<CoordinateResult> {
    let current = formation;
    // Specs bisected-out this pass — excluded from the re-formed batch so a re-form never
    // re-includes a known culprit (the loop strictly shrinks).
    const excludedSpecIds = new Set<string>();

    // The loop bound: at most one entry is removed per iteration, so it cannot exceed the initial
    // batch size + 1 (the final all-clear merge). A hard ceiling against any logic error spinning.
    const maxIterations = formation.eligibleCount + 1;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (current.batch.length === 0) {
        // Everything eligible was bisected out (all-culprits) — nothing to merge; the culprits
        // re-enter via re-drive later. Progress, not an infra error — clear the streak.
        await this.infraHolds.reset(projectId);
        return { projectId, holdReason: "all_blocked", queueDepth };
      }

      if (current.capped) {
        // The cap LOG (operator visibility — never a SILENT truncation): the remainder keeps its position for next pass.
        const cap = { projectId, batchSize: current.batch.length, eligible: current.eligibleCount, maxBatchSize };
        log.info("batch CAPPED; remainder re-considered next pass", cap);
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
          await this.infraHolds.reset(projectId);
        }
        return result;
      }

      if (verdict.result === "pending") {
        await this.infraHolds.reset(projectId);
        const retryAfterMs = verdict.settleAfterMs ?? PENDING_RECHECK_MS;
        return { projectId, holdReason: "all_blocked", retryAfterMs, queueDepth };
      }

      // BASE-CONFLICT SHORT-CIRCUIT: drive a dirty-vs-base PR through the per-run resolver.
      if (verdict.result === "conflict" && verdict.conflictsWithBase) {
        const result = await driveBaseConflict(this.deps, projectId, current.batch, verdict, queueDepth);
        return this.settleConflictDriveResult(result, projectId, queueDepth);
      }

      // The bisect culprit's failure sub-kind (routed once): `fail` → WRITER REWORK (v35 fix,
      // `settleBisectCulprit`); `conflict` → DRIVEN through the per-run resolver (`driveConflictCulprit`).
      const isGateFail = verdict.result === "fail";
      const failMessage = verdict.result === "conflict" ? `integration conflict: ${verdict.message}` : verdict.message;
      await this.deps.batchEvents.emitBisecting({ projectId, batch: current.batch, message: failMessage });

      const bisect = await this.bisectBatch(projectId, current.batch);
      if (bisect === "pending") {
        await this.infraHolds.reset(projectId);
        // A sub-batch's CI was still running — HOLD (no entry blamed). Bug B: back off with a `retryAfterMs` so the subscriber re-drives once, not on every unrelated NOTIFY.
        return { projectId, holdReason: "all_blocked", retryAfterMs: PENDING_RECHECK_MS, queueDepth };
      }
      if ("kind" in bisect) {
        // A sub-batch check could NOT be RUN (a transient infra error) — bisect never blames a PR
        // for a check that never ran. HOLD loudly via the SAME cross-pass ceiling.
        if (bisect.cause !== undefined) {
          return this.terminalInfraBlock(projectId, current.batch, bisect.message, queueDepth, bisect.cause);
        }
        return this.infraHold(projectId, current.batch, bisect.message, queueDepth);
      }

      const { culprit, innocentPrefix, checks } = bisect;
      await this.deps.batchEvents.emitCulprit({ projectId, culprit, checks, message: failMessage });

      if (!isGateFail) {
        // Land the passing prefix first so the culprit's resolver sees the newly-current base.
        if (innocentPrefix.length > 0) {
          await this.infraHolds.reset(projectId);
          const prefixResult = await this.mergeBatch(projectId, innocentPrefix, queueDepth);
          if (prefixResult.mergedSpecId !== innocentPrefix.at(-1)?.specId) return prefixResult;
        }
        const result = await driveConflictCulprit(this.deps, projectId, culprit, queueDepth);
        return this.settleConflictDriveResult(result, projectId, queueDepth);
      }
      // A GATE-fail culprit: route to WRITER REWORK (v35) + retire the OLD entry `superseded`, then re-form + continue.
      await this.infraHolds.reset(projectId);
      await settleBisectCulprit(this.deps, projectId, culprit, isGateFail, verdict.message, failMessage);
      excludedSpecIds.add(culprit.specId);

      // RE-FORM without the culprit (reload so it is gone + a newly-eligible entry can join), re-check next loop.
      const refreshed = await this.deps.queue.loadSnapshot(projectId);
      const reformed = formBatch(refreshed, maxBatchSize);
      reformed.batch = reformed.batch.filter((e) => !excludedSpecIds.has(e.specId));
      current = reformed;
    }

    // The loop bound was hit (a logic guard — unreachable since each fail removes one entry). Hold.
    await this.infraHolds.reset(projectId);
    return { projectId, holdReason: "all_blocked", queueDepth };
  }

  /**
   * Map a conflict-culprit drive result (`driveBaseConflict` / `driveConflictCulprit`) into the
   * pass's return: an infra hold attributes only the driven culprit through the runaway guard;
   * otherwise the real merge/dequeue/hold ends the streak. Shared by both conflict paths.
   */
  private async settleConflictDriveResult(
    result: CoordinateResult | BatchDriveInfraHold,
    projectId: string,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    if (!("projectId" in result)) {
      if (result.kind === "infra_terminal") {
        return this.terminalInfraBlock(projectId, [result.entry], result.message, queueDepth, result.terminalKind);
      }
      return this.infraHold(projectId, [result.entry], result.message, queueDepth);
    }
    await this.infraHolds.reset(projectId);
    return result;
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
    // `sawInfra` is the PROGRESS gate (NOT a count): re-poll the SAME transient once, then hand off ANY recurrence to the cross-pass hold (spin-free).
    let sawInfra = false;
    for (;;) {
      if (sawInfra) await this.sleep(INFRA_RETRY_BACKOFF_MS);
      await this.deps.batchEvents.emitChecking({ projectId, batch: formation.batch, formation, maxBatchSize });
      const verdict = await this.checkEntries(projectId, formation.batch);
      if (verdict.result !== "infra-error") {
        return { kind: "verdict", verdict };
      }
      lastMessage = verdict.message;
      // Required config cannot self-heal via timed re-drive.
      if (!verdict.retriable) return { kind: "infra-terminal", message: lastMessage, cause: verdict.kind };
      // A second infra-error is no longer clear-progress → hand off to the cross-pass hold.
      if (sawInfra) return { kind: "infra-exhausted", message: lastMessage };
      sawInfra = true;
    }
  }

  /** GAP #1 + v54 #56: hold (signature shifting) or ESCALATE to writer rework (signature non-recovering). */
  private async infraHold(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    message: string,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    const ceiling = this.infraHolds;
    const { queue, events, batchEvents, gateRework, tx } = this.deps;
    const verdict = await holdOnInfra({ ceiling, queue, events: batchEvents, projectId, batch, message, queueDepth });
    if (verdict.kind === "hold") return verdict.result;
    if (gateRework === undefined) return this.terminalInfraBlock(projectId, batch, message, queueDepth);
    return escalateInfraHoldToWriter({
      queue,
      events,
      batchEvents,
      gateRework,
      ceiling,
      projectId,
      batch,
      message,
      holds: verdict.holds,
      queueDepth,
      ...(tx === undefined ? {} : { tx }),
    });
  }

  /**
   * Speculatively integrate + CI-check the entry set on an ephemeral integration ref (empty set =
   * base alone, the bisect lower-bound). A THROWN checker means the check could not be RUN (a
   * transport/ref infra error, NEVER a PR's fault) → the `infra-error` verdict (NOT `fail`): the
   * caller re-polls then HOLDS loudly. `retriable` derives from the typed provider error.
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
   * Binary-search the failed batch to isolate the single offending PR (`bisectCulprit` over
   * `checkEntries`). Returns the bisect result on a pass→fail boundary; `"pending"` when a sub-batch
   * CI was still running (HOLD); `{kind:"infra"}` when a sub-batch check could NOT be RUN → HOLD.
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
        return this.infraHold(projectId, [outcome.entry], outcome.message, queueDepth);
      }
      if (outcome.kind === "infra_terminal") {
        return this.terminalInfraBlock(projectId, [outcome.entry], outcome.message, queueDepth, outcome.terminalKind);
      }
      if (outcome.kind === "merged") {
        await this.deps.recoverableDriveHolds?.reset(entry.queueId);
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
    await this.infraHolds.reset(projectId);
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
