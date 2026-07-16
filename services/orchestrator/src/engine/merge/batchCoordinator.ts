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
import type { MergeQueueEventEmitter } from "./coordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import type { RecoveryOwnedSettlementWriter } from "../contracts/runStateWriter.js";
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
import { driveMultiMemberPass } from "./multiMemberAuthorityEmbark.js";
import type { BatchAuthorityEvaluator } from "./multiMemberAuthorityTypes.js";
import { createLogger } from "../observability/logger.js";
export { DEFAULT_MAX_BATCH_SIZE };
const log = createLogger("batch-coordinator");
const INFRA_RETRY_BACKOFF_MS = 500;
const PENDING_RECHECK_MS = 15_000;
class BatchCheckStillPendingError extends Error {}
/** Bisect sub-check could not RUN (infra) — abort bisect + HOLD; never blame an innocent PR. */
class BatchCheckInfraError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly kind?: "missing_required_credential",
  ) {
    super(message);
  }
}

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
  emitCulprit(input: { projectId: string; culprit: MergeQueueEntry; checks: number; message: string }): Promise<void>;
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
  authorityEvaluator: BatchAuthorityEvaluator;
  /** The base queue-event emitter (merge.queue.advanced / merge.dequeued — reused). */
  events: MergeQueueEventEmitter;
  /** The batch-level event emitter (merge.batch.*). */
  batchEvents: BatchMergeEventEmitter;
  /** §2c spec-escalator: parks irreconcilable specs at `needs_attention` (shared with native queue). */
  escalator: SpecEscalator;
  /** Writer-rework router for gate-fail bisect + sustained infra hold. Prod always wires it. */
  gateRework?: BatchGateReworkRouter;
  recoverableDriveHolds?: RecoverableDriveHoldCeiling;
  /** Atomic active-successor proof + canonical event + exact queue retirement. */
  recoverySettlement?: RecoveryOwnedSettlementWriter;
  /** Audit RC-7: the DURABLE backing store for BOTH runaway-guard ceilings, so the counters survive a restart (absent → in-memory, for fakes). */
  holdCeilingStore?: HoldCeilingStore;
  /** Per-project max batch size resolver. Default → `DEFAULT_MAX_BATCH_SIZE`; prod reads `projects.config.maxBatchSize`. */
  resolveMaxBatchSize?: (projectId: string) => Promise<number>;
  /** Test seam: the sleep between infra-error re-polls. Defaults to a real timer; a test injects a no-op/recording sleep so re-polls run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/** Production BatchMergeCoordinator: speculative batch-check + bisect over the native queue. */
export class BatchMergeCoordinator implements MergeCoordinator {
  private readonly resolveMaxBatchSize: (projectId: string) => Promise<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Cross-pass consecutive-infra-hold ceiling (runaway guard). */
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
      await this.infraHolds.reset(projectId);
      const retryAfterMs = holdReason === "serialized" ? serializedRetryAfterMs(snapshot) : undefined;
      return { projectId, holdReason, queueDepth, ...(retryAfterMs !== undefined && { retryAfterMs }) };
    }

    // Run the batch through check → (pass: merge all | fail: bisect + re-check). The
    // recursion re-forms the batch WITHOUT the culprit each fail, so the innocent PRs
    // still merge; it terminates because each bisect strictly removes one entry.
    return this.processBatch(projectId, formation, queueDepth, maxBatchSize);
  }

  /** Check formed batch; on pass merge all; on fail isolate culprit + re-check remainder. */
  private async processBatch(
    projectId: string,
    formation: BatchFormation,
    queueDepth: number,
    maxBatchSize: number,
  ): Promise<CoordinateResult> {
    let current = formation;
    const excludedSpecIds = new Set<string>();
    const maxIterations = formation.eligibleCount + 1;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (current.batch.length === 0) {
        // Everything eligible was bisected out (all-culprits) — nothing to merge; the
        // dequeued culprits re-enter via re-execution later. Progress, not an infra
        // error — clear the streak.
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
        const result = await driveMultiMemberPass({
          deps: this.deps,
          projectId,
          batch: current.batch,
          binding: verdict.authorityBinding,
          integrationBranch: verdict.integrationBranch,
          queueDepth,
          emitPassed: (batch, integrationBranch) =>
            this.deps.batchEvents.emitPassed({ projectId, batch, integrationBranch }),
          drive: (batch) => this.mergeBatch(projectId, batch, queueDepth),
        });
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
        if (!("projectId" in result)) {
          if (result.kind === "infra_terminal") {
            return this.terminalInfraBlock(projectId, [result.entry], result.message, queueDepth, result.terminalKind);
          }
          return this.infraHold(projectId, current.batch, result.message, queueDepth);
        }
        await this.infraHolds.reset(projectId);
        return result;
      }

      await this.infraHolds.reset(projectId);

      const isGateFail = verdict.result === "fail";
      const failMessage = verdict.result === "conflict" ? `integration conflict: ${verdict.message}` : verdict.message;
      await this.deps.batchEvents.emitBisecting({ projectId, batch: current.batch, message: failMessage });

      const bisect = await this.bisectBatch(projectId, current.batch);
      if (bisect === "pending") {
        // A sub-batch's CI was still running — HOLD (no entry blamed). Bug B: back off with a
        // `retryAfterMs` so the subscriber re-drives once rather than on every unrelated NOTIFY.
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

      const { culprit, innocentPrefix, checks } = bisect;
      await this.deps.batchEvents.emitCulprit({ projectId, culprit, checks, message: failMessage });

      if (!isGateFail) {
        // Prefix first; incomplete prefix stops before culprit drive.
        let prefixMergedSpecId: string | undefined;
        if (innocentPrefix.length > 0) {
          const prefixResult = await this.mergeBatch(projectId, innocentPrefix, queueDepth);
          if (prefixResult.mergedSpecId !== innocentPrefix.at(-1)?.specId) return prefixResult;
          prefixMergedSpecId = prefixResult.mergedSpecId;
        }
        const result = await driveConflictCulprit(this.deps, projectId, culprit, queueDepth);
        const settled = await this.settleConflictDriveResult(result, projectId, current.batch, queueDepth);
        if (prefixMergedSpecId !== undefined && settled.mergedSpecId === undefined) {
          return { ...settled, mergedSpecId: prefixMergedSpecId };
        }
        return settled;
      }

      const gateSettled = await settleBisectCulprit(
        this.deps,
        projectId,
        culprit,
        isGateFail,
        verdict.message,
        failMessage,
      );
      if (gateSettled === "retained") {
        return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: 3000 };
      }
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

  private async settleConflictDriveResult(
    result: CoordinateResult | BatchDriveInfraHold,
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    if ("projectId" in result) {
      if (result.holdReason === "infra_error" || result.holdReason === "infra_blocked") return result;
      await this.infraHolds.reset(projectId);
      return result;
    }
    if (result.kind === "infra_terminal") {
      return this.terminalInfraBlock(projectId, [result.entry], result.message, queueDepth, result.terminalKind);
    }
    const holdBatch = result.entry === undefined ? batch : [result.entry];
    return this.infraHold(projectId, holdBatch, result.message, queueDepth);
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
    // `sawInfra` is the PROGRESS gate (NOT a count): re-poll the SAME transient once, then hand
    // off ANY recurrence to the cross-pass sustained-non-recovery hold (spin-free).
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
      // A second infra-error (identical = fixed point, shifted = evolving) is no longer
      // clear-progress → hand off to the cross-pass sustained-non-recovery hold.
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
    const { queue, events, batchEvents, gateRework } = this.deps;
    const verdict = await holdOnInfra({ ceiling, queue, events: batchEvents, projectId, batch, message, queueDepth });
    if (verdict.kind === "hold") return verdict.result;
    if (gateRework === undefined) return this.terminalInfraBlock(projectId, batch, message, queueDepth);
    return escalateInfraHoldToWriter({
      queue,
      events,
      batchEvents,
      gateRework,
      escalator: this.deps.escalator,
      ...(this.deps.recoverySettlement === undefined ? {} : { recoverySettlement: this.deps.recoverySettlement }),
      ceiling,
      projectId,
      batch,
      message,
      holds: verdict.holds,
      queueDepth,
    });
  }

  /** Speculative integrate + CI-check. Thrown checker → infra-error (never blame a PR). */
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

  /** Binary-search failed batch for the single culprit (pending/infra hold without blame). */
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
        await this.deps.recoverableDriveHolds?.reset(entry.queueId);
        await this.deps.queue.markMerged(entry.queueId);
        mergedSpecId = entry.specId;
        continue;
      }

      const settled = await settleDriveOutcome(this.deps, projectId, entry, outcome);
      if (settled !== "dequeued") {
        return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: settled.retryAfterMs };
      }
      // mq-1: member isolation — a dequeued policy culprit must not stop eligible siblings.
      dequeuedSpecId = entry.specId;
      continue;
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
      escalator: this.deps.escalator,
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
