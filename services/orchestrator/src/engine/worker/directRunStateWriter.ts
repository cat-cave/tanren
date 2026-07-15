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
import { withJobOrgScope, type QueryClient } from "../data/orgScopedDb.js";
import { scalarTextOr } from "../data/scalarText.js";
import type pg from "pg";
import type {
  AppendSpecSteeringInput,
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
  RecordDraftPrCreatedInput,
  RecordDraftPrCreatedOutcome,
  ReconcileCostInput,
  RecoveryParkInput,
  RecoveryParkOutcome,
  RecoveryParkWriter,
  ResumePausedRunAtomicInput,
  ResumePausedRunAtomicOutcome,
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
  applyAppendSpecSteering,
  applyClearRunPercolationPending,
  applyFinalizeRunWithEvent,
  applyInsertTask,
  applyMergeRunVerifiedAncestorSha,
  applyResumePausedRunAtomic,
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
  resumePausedRunPairSchema,
  runPairSchema,
  specPairSchema,
  terminalPairSchema,
} from "./runStateLifecycleSql.js";
import { applyFinalizeLand } from "../merge/mergeAuthorityLandFinalizer.js";
import { applyRecordDraftPrCreated } from "../merge/draftPrCreatedAtomic.js";
import { applyRecoveryParkAtomic, parseRecoveryParkInput, recoveryParkingFailed } from "./recoveryParkAtomic.js";

/**
 * The in-process run-state writer. Constructed with the worker's pool (typically
 * an `orgScopingPool` so its standalone event/cost writes are per-job
 * org-scoped). `finalizeRun` opens its OWN `runWithOrgScope(orgId)` so the
 * finalize UPDATE + the matching event share one org-scoped transaction —
 * identical to the worker's prior `withRunFinalizeScope`.
 */
export class DirectRunStateWriter implements RunStateWriter, RecoveryParkWriter {
  /**
   * apex v87: local pool can INSERT `events` — batch coordinator may co-transact
   * dequeue settle with merge_queue UPDATEs (see `canCoTransactMergeSettle`).
   */
  readonly localMergeSettleCoTx = true as const;
  private readonly eventStore: PgEventStore;
  private readonly recorder: CostRecorder;

  constructor(private readonly pool: pg.Pool) {
    this.eventStore = new PgEventStore(pool);
    // Notional is priced from the recorder's default LIVE, self-healing price
    // source (LiteLLM upstream on a short TTL, vendored seed as offline fallback;
    // frozen to the seed under the test runner) — see CostRecorder.
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
  // an explicit input or the ambient per-job scope (`getJobOrgId`) and ALWAYS
  // open a short `runWithOrgScope` — never a bare-pool fallback. Missing both
  // throws `MissingOrgScopeError` (issue #827 / CX-005).

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

  async recordDraftPrCreated(input: RecordDraftPrCreatedInput): Promise<RecordDraftPrCreatedOutcome> {
    // apex v86: post-PR-open 3-write block on ONE org-scoped client — same applier
    // the control-plane `/internal/record-draft-pr-created` endpoint runs.
    return runWithOrgScope(this.pool, input.orgId, (client) => applyRecordDraftPrCreated(client, input));
  }

  async setSpecStatus(input: SetSpecStatusInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetSpecStatus(client, input));
  }

  async setSpecMetadata(input: SetSpecMetadataInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetSpecMetadata(client, input));
  }

  async appendSpecSteering(input: AppendSpecSteeringInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applyAppendSpecSteering(client, input));
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
    // Atomic terminal-row + terminal-event seam: ONE org-scoped transaction so
    // the row UPDATE + event INSERT commit together. Fails loud on unresolved
    // org (same fail-closed path as every other tenant task op — issue #827).
    // Returns the IDEMPOTENT-retry outcome the applier surfaces — `alreadyTerminal:
    // true` when the partial unique index `events_task_terminal_unique` deduped
    // the event INSERT (the original landed, this is a retry; task #40 Class B).
    return this.inTaskScopeResult(input.task.orgId, (client) => applyUpdateTaskWithEvent(client, input));
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

  async parkRecoveryAndDequeue(input: RecoveryParkInput): Promise<RecoveryParkOutcome> {
    const parsed = parseRecoveryParkInput(input);
    if (parsed === undefined) {
      return recoveryParkingFailed("invalid_input");
    }
    try {
      return await runWithOrgScope(this.pool, parsed.orgId, (client) => applyRecoveryParkAtomic(client, parsed));
    } catch {
      // A pre-COMMIT DB/event failure rolls back; a lost COMMIT acknowledgement is
      // inherently uncertain. Never fabricate a dequeue receipt in either case —
      // the idempotent redrive resolves the durable queue anchor.
      return recoveryParkingFailed("write_failed");
    }
  }

  async resumePausedRunAtomic(input: ResumePausedRunAtomicInput): Promise<ResumePausedRunAtomicOutcome> {
    // Audit finding #3 — validate ALL FOUR writes' pair-shapes at the SEAM,
    // so a misuse is rejected BEFORE any DB I/O (mirrors the existing atomic
    // surfaces). The applier runs the run-finalize + run.resumed + spec flip
    // + dag.spec.redriven in ONE org-scoped transaction so a crash mid-apply
    // rolls back the whole unit (no `halted` + `in_flight` split-write orphan).
    resumePausedRunPairSchema.parse(input);
    return runWithOrgScope(this.pool, input.finalize.orgId, (client) => applyResumePausedRunAtomic(client, input));
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
   * Run a tenant task op under the right org scope. An explicit `orgId` opens a
   * short `runWithOrgScope`; otherwise resolution delegates entirely to the
   * canonical 4-arm {@link withJobOrgScope} (ambient connection scope → job org
   * → system job scope → {@link MissingOrgScopeError}). NEVER falls back to the
   * bare pool (issue #827 / CX-005).
   */
  private async inTaskScope(orgId: string | undefined, op: (client: QueryClient) => Promise<void>): Promise<void> {
    await this.inTaskScopeResult(orgId, op);
  }

  /**
   * Value-returning variant of {@link inTaskScope} (task #40 Class B): the
   * idempotent-retry outcome (`alreadyTerminal: true/false`) flows out of the
   * applier inside the same fail-closed org-scoped transaction.
   *
   * Explicit `orgId` short-circuits to `runWithOrgScope` (and defense-in-depth
   * asserts it matches the ambient job org when both are present). All ambient
   * resolution goes through {@link withJobOrgScope} so arms 1 (open connection)
   * and 3 (system job scope) are preserved — not re-implemented here.
   */
  private async inTaskScopeResult<T>(orgId: string | undefined, op: (client: QueryClient) => Promise<T>): Promise<T> {
    if (orgId !== undefined) {
      const jobOrgId = getJobOrgId();
      if (jobOrgId !== undefined && jobOrgId !== orgId) {
        throw new Error(
          `DirectRunStateWriter.inTaskScope: explicit orgId ${JSON.stringify(orgId)} conflicts with ambient job org ${JSON.stringify(jobOrgId)}`,
        );
      }
      return runWithOrgScope(this.pool, orgId, (client) => op(client));
    }
    return withJobOrgScope(this.pool, op);
  }
}
