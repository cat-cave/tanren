// Plane-split P3: the DEFAULT (in-process, direct-DB) run-state writer. Performs
// the EXACT writes the worker has always done — the `PgEventStore` INSERT, the
// `CostRecorder.record` INSERT, and the run-finalize `UPDATE runs` — under the
// worker's per-job org scope, on the worker's own (`tanren_app`) pool.
//
// This is the unchanged behavior: handed an `orgScopingPool(pool)` it self-routes
// every write through the per-job org-scoped short transaction (R3a-worker), and
// the finalize runs its UPDATE + the matching `run.*` event in ONE org-scoped
// transaction (the `withRunFinalizeScope` behavior). Selecting this writer (the
// default, no flag) keeps the data plane writing tenant tables directly — so P3
// is fully REVERSIBLE: flipping the flag off restores the pre-P3 write path.

import { getJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  FinalizeRunInput,
  FinalizeRunResult,
  InsertTaskInput,
  RecordCostInput,
  ReconcileCostInput,
  RunStateWriter,
  SetRunPrUrlInput,
  SetRunStatusInput,
  SetSpecStatusInput,
  UpdateTaskInput,
} from "../contracts/runStateWriter.js";
import { CostRecorder, type RecordedCost } from "../costs/recorder.js";
import type { EventName } from "../events/index.js";
import { PgEventStore, type AppendEventInput } from "../eventStore.js";
import {
  applyInsertTask,
  applySetRunPrUrl,
  applySetRunStatus,
  applySetSpecStatus,
  applySupersedeQueuedPlannerTask,
  applyUpdateTask,
} from "./runStateLifecycleSql.js";

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
      return { updated: true, specId: String(row.spec_id ?? ""), projectId: String(row.project_id ?? "") };
    });
  }

  // --- Plane-split P3c: the run/spec/task lifecycle writes. ---
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

  async setSpecStatus(input: SetSpecStatusInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => applySetSpecStatus(client, input));
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
}
