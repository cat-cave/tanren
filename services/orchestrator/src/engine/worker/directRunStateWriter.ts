// The DEFAULT (in-process, direct-DB) run-state writer. Performs
// the EXACT writes the worker has always done — the `PgEventStore` INSERT, the
// `CostRecorder.record` INSERT, and the run-finalize `UPDATE runs` — under the
// worker's per-job org scope, on the worker's own (`tanren_app`) pool.
//
// This is the unchanged behavior: handed an `orgScopingPool(pool)` it self-routes
// every write through the per-job org-scoped short transaction (R3a-worker), and
// the finalize runs its UPDATE + the matching `run.*` event in ONE org-scoped
// transaction (the `withRunFinalizeScope` behavior). Selecting this writer (the
// default, no flag) keeps the data plane writing tenant tables directly — so the cutover
// is fully REVERSIBLE: flipping the flag off restores the direct write path.

import { getJobOrgId, runWithOrgScope } from "@tanren/db";
import { MissingOrgScopeError } from "../data/orgScopedDb.js";
import { scalarTextOr } from "../data/scalarText.js";
import type pg from "pg";
import type {
  ClearRunPercolationPendingInput,
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  FinalizeLandInput,
  FinalizeRunInput,
  FinalizeRunResult,
  FinalizeRunWithEventInput,
  FinalizeRunWithEventOutcome,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  RecordCostInput,
  ReconcileCostInput,
  RunStateWriter,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateSpecWithEventInput,
  UpdateSpecWithEventOutcome,
  UpdateTaskInput,
  UpdateTaskWithEventInput,
  UpdateTaskWithEventOutcome,
} from "../contracts/runStateWriter.js";
import { CostRecorder, type RecordedCost } from "../costs/recorder.js";
import type { EventName } from "../events/index.js";
import { PgEventStore, type AppendEventInput } from "../eventStore.js";
import {
  createQueuedRunFromSpec,
  createSpec as createSpecImpl,
  type SpecContract,
  type SpecRunContract,
} from "../workflow/projectSpec.js";
import {
  applyClearRunPercolationPending,
  applyFinalizeRunWithEvent,
  applyInsertTask,
  applyMergeRunVerifiedAncestorSha,
  applySetRunAuthRef,
  applySetRunPercolationReexecId,
  applySetRunPrUrl,
  applySetRunSpeculativeBase,
  applySetRunStatus,
  applySetSpecMetadata,
  applySetSpecStatus,
  applySupersedeQueuedPlannerTask,
  applyUpdateSpecWithEvent,
  applyUpdateTask,
  applyUpdateTaskWithEvent,
  runPairSchema,
  specPairSchema,
  terminalPairSchema,
} from "./runStateLifecycleSql.js";
import { applyFinalizeLand } from "../merge/mergeAuthorityLandFinalizer.js";

/**
 * The in-process run-state writer. Constructed with the worker's pool (typically
 * an `orgScopingPool` so its standalone event/cost writes are per-job
 * org-scoped). `finalizeRun` opens its OWN `runWithOrgScope(orgId)` so the
 * finalize UPDATE + the matching event share one org-scoped transaction —
 * identical to the worker's prior `withRunFinalizeScope`.
 */
export class DirectRunStateWriter implements RunStateWriter {
  private readonly eventStore: PgEventStore;
  private readonly recorder: CostRecorder;

  constructor(private readonly pool: pg.Pool) {
    this.eventStore = new PgEventStore(pool);
    this.recorder = new CostRecorder(pool, this.eventStore);
  }

  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    await this.eventStore.append(input);
  }

  async recordCost(input: RecordCostInput): Promise<RecordedCost> {
    return this.recorder.record(input.context, input.tokens, input.rawUsage);
  }

  async reconcileCost(input: ReconcileCostInput): Promise<{ updated: number }> {
    // The apportioning SELECT + per-row UPDATEs run in ONE org-scoped transaction
    // (the recorder handed an in-transaction client uses it verbatim), identical
    // to the worker's prior in-process reconcile — only the explicit org opens
    // the scope (no ambient per-job org-id is required on this path).
    return runWithOrgScope(this.pool, input.orgId, async (client) =>
      new CostRecorder(client, new PgEventStore(client)).applyReconcile(input.runId, input.totalCostUsd, input.basis),
    );
  }

  async finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
    // The finalize UPDATE + its event run in ONE org-scoped transaction so both
    // carry org context — the exact behavior of the worker's prior finalizers.
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const updated = await client.query(
        `UPDATE runs SET status = $2, outcome = $3, ended_at = now()
         WHERE run_id = $1 AND status = ANY($4::text[])
         RETURNING spec_id, project_id`,
        [input.runId, input.status, input.outcome, input.fromStatuses],
      );
      const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
      if (row === undefined) {
        return { updated: false };
      }
      return { updated: true, specId: scalarTextOr(row.spec_id, ""), projectId: scalarTextOr(row.project_id, "") };
    });
  }

  // --- the run/spec/task lifecycle writes. ---
  //
  // The run/spec ops carry an explicit org, so they open their OWN
  // `runWithOrgScope(orgId)` (like `finalizeRun`). The task ops resolve org from
  // the ambient per-job scope when omitted and run on `this.pool` — which, handed
  // the worker's `orgScopingPool`, self-routes each write through the per-job
  // org-scoped short transaction, byte-identical to the workflow's prior direct
  // task writes.

  async setRunStatus(input: SetRunStatusInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetRunStatus(client, input));
  }

  async setRunPrUrl(input: SetRunPrUrlInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetRunPrUrl(client, input));
  }

  async setRunAuthRef(input: SetRunAuthRefInput): Promise<void> {
    // The subtask loop carries no explicit org on its context, so (like the task ops)
    // resolve it from the ambient per-job scope when omitted.
    await this.inTaskScope(input.orgId, (client) => applySetRunAuthRef(client, input));
  }

  async finalizeLand(input: FinalizeLandInput): Promise<{ auditId: string }> {
    // The §5 durable land transaction (merge.completed + the guarded spec `merged`
    // flip) in ONE org-scoped transaction — the SAME applier the control-plane
    // endpoint runs server-side.
    await runWithOrgScope(this.pool, input.orgId, (client) => applyFinalizeLand(client, input));
    return { auditId: input.runId };
  }

  async setSpecStatus(input: SetSpecStatusInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetSpecStatus(client, input));
  }

  async setSpecMetadata(input: SetSpecMetadataInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetSpecMetadata(client, input));
  }

  async setRunSpeculativeBase(input: SetRunSpeculativeBaseInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetRunSpeculativeBase(client, input));
  }

  async setRunPercolationReexecId(input: SetRunPercolationReexecIdInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetRunPercolationReexecId(client, input));
  }

  async clearRunPercolationPending(input: ClearRunPercolationPendingInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applyClearRunPercolationPending(client, input));
  }

  async mergeRunVerifiedAncestorSha(input: MergeRunVerifiedAncestorShaInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applyMergeRunVerifiedAncestorSha(client, input));
  }

  async supersedeQueuedPlannerTask(input: { runId: string; orgId?: string }): Promise<void> {
    await this.inTaskScope(input.orgId, (client) => applySupersedeQueuedPlannerTask(client, input.runId));
  }

  async insertTask(input: InsertTaskInput): Promise<void> {
    await this.inTaskScope(input.orgId, (client) => applyInsertTask(client, input));
  }

  async updateTask(input: UpdateTaskInput): Promise<void> {
    await this.inTaskScope(input.orgId, (client) => applyUpdateTask(client, input));
  }

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<UpdateTaskWithEventOutcome> {
    // Validate the pairing constraint at the SEAM (terminal transition + matching
    // terminal event), so a misuse is rejected BEFORE any DB I/O. The atomic
    // primitive REQUIRES a terminal + matching shape — a non-terminal transition
    // or a mismatched (e.g. `done` ↔ `task.failed`) pair is a wiring bug, not a
    // degraded recovery to swallow. The event PAYLOAD is parsed downstream by
    // `PgEventStore.append` against the registry schema for the named type
    // (the type-specific decode lives in ONE place); the refinement here only
    // pins the pairing shape.
    terminalPairSchema.parse(input);
    // The atomic primitive REQUIRES a transactional scope — the bare-pool fallback
    // in `inTaskScope` would degrade silently to two separate statements (the row
    // UPDATE + the event INSERT each on their own connection), defeating the whole
    // point of this seam. Other `inTaskScope` callers stay unchanged; THIS method
    // is the only one that fails loud on an unresolved org (mirrors `withJobOrgScope`).
    // Returns the IDEMPOTENT-retry outcome the applier surfaces — `alreadyTerminal:
    // true` when the partial unique index `events_task_terminal_unique` deduped
    // the event INSERT (the original landed, this is a retry; task #40 Class B).
    return this.inTaskScopeOrThrowResult(input.task.orgId, (client) => applyUpdateTaskWithEvent(client, input));
  }

  async finalizeRunWithEvent(input: FinalizeRunWithEventInput): Promise<FinalizeRunWithEventOutcome> {
    // Validate the pairing constraint (terminal run outcome + matching terminal event)
    // BEFORE any DB I/O — a misuse is rejected at the seam (task #48).
    runPairSchema.parse(input);
    // Mirrors `finalizeRun`'s `runWithOrgScope(this.pool, input.finalize.orgId, ...)`
    // — explicit org from the caller, ONE org-scoped transaction so the row +
    // event live or die together.
    return runWithOrgScope(this.pool, input.finalize.orgId, (client) => applyFinalizeRunWithEvent(client, input));
  }

  async updateSpecWithEvent(input: UpdateSpecWithEventInput): Promise<UpdateSpecWithEventOutcome> {
    // Validate the spec-pair constraint at the SEAM (paired status flip +
    // matching disposition event), so a misuse is rejected BEFORE any DB I/O.
    specPairSchema.parse(input);
    return runWithOrgScope(this.pool, input.spec.orgId, (client) => applyUpdateSpecWithEvent(client, input));
  }

  // --- Autonomy loops: the run/spec CREATE writes (explicit-actor, multi-table). ---
  //
  // `createQueuedRunFromSpec` / `createSpec` already open their OWN
  // `runWithOrgScope(actor.orgId)` (org-carrying actor → org-scoped tx), so the
  // direct path is byte-identical to the loop calling them in-process today.

  async createQueuedRun(input: CreateQueuedRunInput): Promise<SpecRunContract> {
    return createQueuedRunFromSpec(this.pool, input.input, input.actor);
  }

  async createSpec(input: CreateSpecRemoteInput): Promise<SpecContract> {
    return createSpecImpl(this.pool, input.input, input.actor);
  }

  /**
   * Run a task op under its org scope: an explicit org (or the ambient per-job
   * org) opens a short `runWithOrgScope`; absent both, run on `this.pool`
   * verbatim (the `orgScopingPool` self-routes through any open ambient scope) —
   * identical to the workflow's prior in-process task write.
   */
  private async inTaskScope(
    orgId: string | undefined,
    op: (client: pg.Pool | pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const resolved = orgId ?? getJobOrgId();
    if (resolved === undefined) {
      await op(this.pool);
      return;
    }
    await runWithOrgScope(this.pool, resolved, (client) => op(client));
  }

  /**
   * Same as {@link inTaskScope} but FAILS LOUDLY when no org can be resolved
   * (task #39): the atomic terminal-row + terminal-event seam REQUIRES a single
   * `runWithOrgScope` transaction so the row UPDATE + event INSERT COMMIT
   * together. Falling back to the bare pool would silently split them into two
   * separate statements (each on its own pool connection) — defeating the whole
   * point of `updateTaskWithEvent`. Mirrors `withJobOrgScope`'s arm-4 throw.
   */
  private async inTaskScopeOrThrow(
    orgId: string | undefined,
    op: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const resolved = orgId ?? getJobOrgId();
    if (resolved === undefined) {
      throw new MissingOrgScopeError("DirectRunStateWriter.updateTaskWithEvent");
    }
    await runWithOrgScope(this.pool, resolved, (client) => op(client));
  }

  /**
   * Value-returning variant of {@link inTaskScopeOrThrow} (task #40 Class B):
   * the idempotent-retry outcome (`alreadyTerminal: true/false`) flows out of
   * the applier inside the org-scoped transaction. Same arm-4 LOUD throw on a
   * missing org as the void variant — atomicity is the contract, not a
   * silent degrade.
   */
  private async inTaskScopeOrThrowResult<T>(
    orgId: string | undefined,
    op: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const resolved = orgId ?? getJobOrgId();
    if (resolved === undefined) {
      throw new MissingOrgScopeError("DirectRunStateWriter.updateTaskWithEvent");
    }
    return runWithOrgScope(this.pool, resolved, (client) => op(client));
  }
}
