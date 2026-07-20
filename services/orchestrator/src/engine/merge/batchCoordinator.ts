// Production BatchMergeCoordinator (autonomy-engine.md §2d): batch-check + bisect over the native queue.
import {
  type BatchCheckVerdict,
  type BatchChecker,
  type BatchFormation,
  type BatchGateReworkRouter,
  DEFAULT_MAX_BATCH_SIZE,
  formBatch,
} from "../contracts/batchMergeCoordinator.js";
import {
  type CoordinateResult,
  type MergeCoordinator,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
} from "../contracts/mergeCoordinator.js";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { MergeQueueEventEmitter } from "./coordinator.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import type { RecoveryOwnedSettlementWriter } from "../contracts/runStateWriter.js";
import {
  driveBaseConflict,
  driveConflictCulprit,
  driveClaimedMerge,
  type BatchDriveInfraHold,
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
import type { AutonomousRepairRouter } from "./autonomousRepairRouter.js";
import { createLogger } from "../observability/logger.js";
import { BatchBisector } from "./batchBisector.js";
export { DEFAULT_MAX_BATCH_SIZE };
const log = createLogger("batch-coordinator");
const INFRA_RETRY_BACKOFF_MS = 500;
const PENDING_RECHECK_MS = 15_000;

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
  /** mq-10 autonomous-repair router: classifies an isolated member → repair / respec / blocked. */
  repairRouter?: AutonomousRepairRouter;
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
  private readonly bisector: BatchBisector;
  /** Cross-pass consecutive-infra-hold ceiling (runaway guard). */
  private readonly infraHolds: BatchInfraHoldCeiling;

  constructor(private readonly deps: BatchMergeCoordinatorDeps) {
    this.resolveMaxBatchSize = deps.resolveMaxBatchSize ?? (() => Promise.resolve(DEFAULT_MAX_BATCH_SIZE));
    this.sleep = deps.sleep ?? ((ms) => sleepFor(ms));
    this.bisector = new BatchBisector(deps.checker);
    // Audit RC-7: back both runaway-guard ceilings with the injected durable store (survives a restart).
    this.infraHolds = new BatchInfraHoldCeiling(deps.holdCeilingStore);
    this.deps.recoverableDriveHolds ??= new RecoverableDriveHoldCeiling(deps.holdCeilingStore);
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    await this.deps.queue.recoverStaleClaims(projectId);

    // in-18 integration-grant park/re-admit reconciliation (the always-on backstop,
    // mirroring in-9's prepare pass). RE-ADMIT first so a unit whose grant genuinely
    // arrived (its capability node advanced past awaiting_grant) re-enters the
    // candidate set THIS pass; then PARK any unit newly blocked on an awaiting_grant
    // node so it stops clogging. Both are fail-closed no-ops when unimplemented (a
    // test fake) or when no capability nodes exist. A grant-arrival event separately
    // wakes this pass via the subscriber, so re-admission is genuinely event-driven.
    await this.deps.queue.reAdmitGrantCovered?.(projectId);
    await this.deps.queue.parkGrantBlocked?.(projectId);

    const maxBatchSize = await this.resolveMaxBatchSize(projectId);
    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const queueDepth = snapshot.entries.length;

    const formation = formBatch(snapshot, maxBatchSize);
    if (formation.batch.length === 0) {
      const holdReason = snapshot.mergingInFlight
        ? "serialized"
        : snapshot.entries.length === 0
          ? "empty"
          : "all_blocked";
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

      const bisect = await this.bisector.bisectBatch(projectId, current.batch);
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
      const verdict = await this.bisector.checkEntries(projectId, formation.batch);
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

  private async mergeBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    let mergedSpecId: string | undefined;
    let dequeuedSpecId: string | undefined;
    let leaseContended = false;
    for (const entry of batch) {
      const claimed = await this.deps.queue.claim(entry.queueId);
      if (!claimed) {
        leaseContended = true;
        continue;
      }
      await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

      const outcome = await driveClaimedMerge(this.deps, projectId, entry);
      if (outcome.kind === "infra_hold") {
        return this.infraHold(projectId, batch, outcome.message, queueDepth);
      }
      if (outcome.kind === "infra_terminal") {
        return this.terminalInfraBlock(projectId, [outcome.entry], outcome.message, queueDepth, outcome.terminalKind);
      }
      if (outcome.kind === "merged") {
        await this.deps.recoverableDriveHolds?.reset(entry.queueId);
        if (!(await this.deps.queue.markMerged(entry.queueId))) {
          const refreshed = await this.deps.queue.loadSnapshot(projectId);
          return {
            projectId,
            queueDepth,
            holdReason: "serialized",
            retryAfterMs: serializedRetryAfterMs(refreshed),
          };
        }
        mergedSpecId = entry.specId;
        continue;
      }

      const settled = await settleDriveOutcome(this.deps, projectId, entry, outcome);
      if (settled !== "dequeued") {
        return { projectId, queueDepth, holdReason: "merge_retry", retryAfterMs: settled.retryAfterMs };
      }
      dequeuedSpecId = entry.specId;
      continue;
    }
    if (mergedSpecId === undefined && dequeuedSpecId === undefined && leaseContended) {
      const refreshed = await this.deps.queue.loadSnapshot(projectId);
      return {
        projectId,
        queueDepth,
        holdReason: "serialized",
        retryAfterMs: serializedRetryAfterMs(refreshed),
      };
    }
    return {
      projectId,
      queueDepth,
      ...(mergedSpecId !== undefined && { mergedSpecId }),
      ...(dequeuedSpecId !== undefined && { dequeuedSpecId }),
    };
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
