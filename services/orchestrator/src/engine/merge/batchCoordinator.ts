// The production BatchMergeCoordinator (autonomy-engine.md §2d — speculative
// batch-check + bisect, the intelligence layer over the native merge queue).
// It is a SCHEDULER over the EXISTING per-run merge path (the SAME MergeRunner /
// MergeQueueModel), NOT a second merge implementation — it adds a speculative
// validation step BEFORE the real merges:
//
// Each pass (`coordinate(projectId)`): (1) recover stale claims (lease) + load
// the queue snapshot under RLS; (2) FORM a batch (the DAG-ordered mutually-eligible
// prefix; capped + logged); (3) BATCH-CHECK the prospective merged state (the
// BatchChecker reuses the SpeculativeIntegrator + the VcsProvider CI seam),
// emitting merge.batch.checking; (4) on PASS → drive the batch's real merges in DAG
// order via the native-queue path (one at a time — serialization holds), emitting
// merge.batch.passed; (5) on FAIL / SPEC-vs-SPEC CONFLICT → BISECT to isolate the single
// offending PR, DEQUEUE it recoverably (routed to re-execution, NOT dropped), and RE-FORM
// + RE-CHECK without it so the innocent PRs still merge. A BASE conflict (a single PR dirty
// against `default_branch`, `conflictsWithBase`) is NOT bisected — it is driven through the
// per-run intent-preserving resolver (the same path that resolves a dirty PR).
//
// INVARIANTS (mirroring the spec): a batch whose check fails NEVER merges to
// default_branch (only a passing prospective state's entries are driven); ordering
// (ancestor-before-dependent) is preserved within + across batches; the culprit's
// work is preserved (recoverable dequeue, never discarded); no innocent PR is dropped;
// bisect terminates (each step shrinks the suspect set); a crash mid-batch leaves the
// queue recoverable (the native queue's lease/recovery, reused unchanged).

import {
  type BatchCheckVerdict,
  type BatchChecker,
  type BatchFormation,
  bisectCulprit,
  DEFAULT_MAX_BATCH_SIZE,
  formBatch,
} from "../contracts/batchMergeCoordinator.js";
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
import { driveBaseConflict, settleDriveOutcome } from "./batchCoordinatorSettle.js";
import { BatchInfraHoldCeiling, holdOnInfra } from "./batchInfraHoldCeiling.js";

/**
 * The bound on in-pass re-checks of the SAME batch after a transient INFRA error (the
 * check could not be RUN). After this many additional attempts the coordinator stops
 * retrying and HOLDS loudly (merge.batch.infra_blocked) — never silently spinning, and
 * never dequeuing a clean PR. Each retry re-checks the full batch (it does NOT shrink).
 */
const MAX_INFRA_RETRIES = 2;
/** Backoff (ms) between infra-error re-checks — overridable via the `sleep` seam in tests. */
const INFRA_RETRY_BACKOFF_MS = [250, 500];

/**
 * Bug B — back off a PENDING batch (no hot loop). When a batch check returns `pending`
 * the coordinator HOLDS, but no `tanren_run` NOTIFY is guaranteed to clear it on its own
 * (a no-checks settle expires on wall time; a registered-CI completion fires a webhook,
 * not necessarily a run NOTIFY). So the pass returns a `retryAfterMs` + the subscriber
 * arms ONE idempotent re-drive timer (the SAME armDelayedReDrive infra), instead of
 * re-checking on every unrelated NOTIFY (the ~2/sec hot loop the live no-CI repo hit).
 * When the verdict carries `settleAfterMs` (the no-checks grace remaining) we wake
 * EXACTLY at expiry; otherwise this default recheck interval applies.
 */
const PENDING_RECHECK_MS = 15_000;

/**
 * Thrown by the bisect callback when a sub-batch's CI is still pending — bisect
 * cannot give a definitive verdict, so the pass aborts the bisect + HOLDS (it never
 * guesses, which could blame an innocent PR). The next CI-completion re-triggers.
 */
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
  /**
   * merge.batch.infra_blocked: the batch check could NOT be run (a transient/transport
   * INFRA error) — the coordinator bounded-retried then HOLDS loudly. NO PR is
   * bisected/dequeued; the entries stay queued (recovered on a delayed re-drive).
   *
   * GAP #1 (runaway guard): when `terminal` is set the per-project CROSS-PASS hold
   * CEILING fired — the coordinator stops re-arming the re-drive timer and surfaces a
   * TERMINAL halt (operator attention; no further auto-retry). `consecutiveHolds` is
   * the count of consecutive infra holds that hit the cap.
   */
  emitInfraBlocked(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    message: string;
    attempts: number;
    terminal?: boolean;
    consecutiveHolds?: number;
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
   * persistent outage re-drove the 3s timer forever. This bounds it to a terminal halt.
   */
  private readonly infraHolds = new BatchInfraHoldCeiling();

  constructor(private readonly deps: BatchMergeCoordinatorDeps) {
    this.resolveMaxBatchSize = deps.resolveMaxBatchSize ?? (() => Promise.resolve(DEFAULT_MAX_BATCH_SIZE));
    this.sleep = deps.sleep ?? ((ms) => sleepFor(ms));
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // crash recovery FIRST: a coordinator that died mid-merge left a stale
    // `merging` claim; return it to `queued` (the merge is idempotent) so this pass
    // re-considers it. The lease (recoverStaleClaims) is the SAME native-queue mechanism.
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
      this.infraHolds.reset(projectId);
      return { projectId, holdReason, queueDepth };
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
      // Check the SAME batch with a bounded retry on a transient INFRA error (the check
      // could not be RUN). On exhaustion → `infraHold` (the GAP #1 cross-pass ceiling),
      // never bisecting any PR.
      const checked = await this.checkBatchWithInfraRetry(projectId, current, maxBatchSize);
      if (checked.kind === "infra-exhausted") {
        return this.infraHold(projectId, current.batch, checked.message, queueDepth);
      }
      const verdict = checked.verdict;

      if (verdict.result === "pass") {
        // Real progress (a runnable verdict) — clear any infra-hold streak.
        this.infraHolds.reset(projectId);
        const { integrationBranch } = verdict;
        await this.deps.batchEvents.emitPassed({ projectId, batch: current.batch, integrationBranch });
        return this.mergeBatch(projectId, current.batch, queueDepth);
      }

      if (verdict.result === "pending") {
        // The prospective merged state's CI is still RUNNING (or the repo has no CI yet
        // and the no-checks grace has not elapsed) — NOT a failure. HOLD (do NOT bisect
        // a not-yet-terminal batch, which could blame an innocent PR). Bug B: return a
        // `retryAfterMs` so the subscriber arms ONE idempotent re-drive timer instead of
        // re-checking on every unrelated `tanren_run` NOTIFY (the no-CI hot loop). Wake
        // EXACTLY at the settle expiry when known (`settleAfterMs`), else the default
        // recheck interval. A pending hold is NOT an infra error — clear the streak.
        this.infraHolds.reset(projectId);
        const retryAfterMs = verdict.settleAfterMs ?? PENDING_RECHECK_MS;
        return { projectId, holdReason: "all_blocked", retryAfterMs, queueDepth };
      }

      // A runnable fail/conflict verdict is real progress (the check RAN) — clear any
      // infra-hold streak.
      this.infraHolds.reset(projectId);

      // BASE-CONFLICT SHORT-CIRCUIT: a `conflict` against the BASE branch (a single PR
      // dirty vs `default_branch`, not a batch interaction) is DRIVEN through the per-run
      // resolver, never bisected — bisect+dequeue would brick it forever (nothing
      // re-admits a conflict-dequeued entry). See `driveBaseConflict`. A spec-vs-spec
      // conflict (`conflictsWithBase` false) keeps the bisect-and-dequeue path below.
      if (verdict.result === "conflict" && verdict.conflictsWithBase) {
        return driveBaseConflict(this.deps, projectId, current.batch, verdict, queueDepth);
      }

      // FAIL / SPEC-vs-SPEC CONFLICT → bisect to isolate the single offending PR.
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
        return this.infraHold(projectId, current.batch, bisect.message, queueDepth);
      }

      // Dequeue the culprit to a RECOVERABLE outcome (conflict reason ⇒ routed to the
      // re-execution path — the run loop re-enqueues it once it re-gates clean; NEVER dropped).
      await this.deps.queue.markDequeued(bisect.culprit.queueId, "conflict");
      const dequeueMessage = `bisected as the offending PR in a failed batch check: ${failMessage}`;
      await this.deps.events.emitDequeued({
        projectId,
        entry: bisect.culprit,
        reason: "conflict",
        message: dequeueMessage,
      });
      const { culprit, checks } = bisect;
      await this.deps.batchEvents.emitCulprit({ projectId, culprit, checks, message: failMessage });
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

  /**
   * Check the FULL formed batch, retrying the SAME batch on a transient INFRA error (a
   * check that could not be RUN — distinct from a CI fail/conflict/pending). Bug 2's
   * core safety: an infra error NEVER bisects/dequeues/blames a PR. Emits
   * merge.batch.checking per attempt; a NON-infra verdict returns unchanged; a retriable
   * `infra-error` with budget remaining backs off (the `sleep` seam) + re-checks the
   * SAME batch (a typed-permanent one skips the budget); on exhaustion returns the raw
   * `infra-exhausted` marker, which the caller routes through `holdOnInfra` (the GAP #1
   * cross-pass ceiling → LOUD merge.batch.infra_blocked, recoverable-hold vs. terminal).
   */
  private async checkBatchWithInfraRetry(
    projectId: string,
    formation: BatchFormation,
    maxBatchSize: number,
  ): Promise<{ kind: "verdict"; verdict: BatchCheckVerdict } | { kind: "infra-exhausted"; message: string }> {
    let lastMessage = "batch check could not run (infra error)";
    for (let attempt = 0; attempt <= MAX_INFRA_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(INFRA_RETRY_BACKOFF_MS[attempt - 1] ?? 500);
      }
      // Announce every check attempt (the initial AND each re-pass) so the timeline
      // shows the batch is being checked — never a silent loop.
      await this.deps.batchEvents.emitChecking({ projectId, batch: formation.batch, formation, maxBatchSize });
      const verdict = await this.checkEntries(projectId, formation.batch);
      if (verdict.result !== "infra-error") {
        return { kind: "verdict", verdict };
      }
      lastMessage = verdict.message;
      // A typed PERMANENT infra error: do not burn the retry budget — hold loudly now.
      if (!verdict.retriable) break;
    }
    // In-pass retries exhausted (or a permanent infra error). The caller holds loudly via
    // the cross-pass ceiling. NEVER dequeue/blame a PR on an infra error.
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
    return holdOnInfra({ ceiling, events: this.deps.batchEvents, projectId, batch, message, queueDepth });
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
  ): Promise<Awaited<ReturnType<typeof bisectCulprit>> | "pending" | { kind: "infra"; message: string }> {
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
          );
        }
        return v.result === "pass" ? "pass" : "fail";
      });
    } catch (error) {
      if (error instanceof BatchCheckStillPendingError) return "pending";
      if (error instanceof BatchCheckInfraError) return { kind: "infra", message: error.message };
      throw error;
    }
  }

  /**
   * Drive the validated batch's REAL merges in DAG order through the native-queue path (the
   * SAME runner/model). Each entry is claimed (serialization lock), driven, + settled —
   * one at a time, ancestor before dependent. A merged entry advances; a non-merged
   * real-merge outcome (a reality the speculative check could not see, e.g. the live
   * base moved) dequeues recoverably + STOPS the batch (no dependent merges ahead of a
   * now-missing ancestor) — the next pass re-forms from the new reality. NEVER merges an
   * entry the batch check did not validate.
   */
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
        // Another pass already claimed it (serialization) — stop; the winning pass
        // drives it. The next trigger re-coordinates.
        break;
      }
      await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

      const outcome = await this.driveOne(projectId, entry);
      if (outcome.kind === "merged") {
        await this.deps.queue.markMerged(entry.queueId);
        mergedSpecId = entry.specId;
        continue;
      }

      // A non-merged real-merge outcome: settle + STOP the batch (no dependent merges
      // ahead of a now-absent ancestor). `settleDriveOutcome` routes `needs_attention`
      // through the NON-BRICKING escalation (park the spec, never re-executed) and a
      // conflict/blocked/failed through the recoverable dequeue — the SAME native-queue policy.
      await settleDriveOutcome(this.deps, projectId, entry, outcome);
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

  /** Drive ONE entry's real merge through the native-queue path; a thrown drive ⇒ recoverable blocked. */
  private async driveOne(projectId: string, entry: MergeQueueEntry): Promise<MergeDriveOutcome> {
    try {
      return await this.deps.runner.driveMerge({ runId: entry.runId, projectId });
    } catch (error) {
      return { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }
  }
}
