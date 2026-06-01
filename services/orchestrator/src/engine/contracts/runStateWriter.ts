// Plane-split P3: the RUN-STATE WRITE seam between the data plane (worker) and
// the control plane (orchestrator). P2 moved only the job CLAIM behind the mTLS
// control-plane endpoint; P3 moves the worker's run-state WRITES — event-append,
// cost-record insert, and run finalize (failed/halted/done) — behind the same
// authenticated channel so a compromised data-plane runner can no longer write
// the control DB directly.
//
// The seam is one interface — {@link RunStateWriter} — with two impls:
//   - `DirectRunStateWriter` performs the SAME org-scoped in-process DB writes
//     the worker does today (the unchanged `PgEventStore` / `CostRecorder` /
//     `UPDATE runs` under the worker's per-job org scope). It is the DEFAULT —
//     lower risk, behavior-identical — so nothing changes unless the remote-write
//     flag is set. This keeps P3 REVERSIBLE.
//   - `HttpRunStateWriter` POSTs each write to the control-plane `/internal/*`
//     write endpoints over the mTLS {@link MtlsFetch} channel. The control plane
//     then performs the EXACT SAME org-scoped write server-side, under ITS DB
//     access — so the data plane needs no broad tenant-table write grants.
//
// WHAT GETS WRITTEN IS IDENTICAL in both impls: same columns/values, same
// org-scoping, same exactly-once semantics — the only difference is WHERE the
// statement runs (in the data plane vs. server-side in the control plane). See
// docs/roadmap/saas-rls-and-plane-split-plan.md (plane-split P3) and R-WAVES.md.

import type { AppendEventInput, EventStore } from "../eventStore.js";
import type { CostRecordContext, RecordedCost } from "../costs/recorder.js";
import type { TokenUsage } from "../providers/types.js";

/** A run-finalize transition the worker drives at run end / failure. */
export interface FinalizeRunInput {
  runId: string;
  /** The owning run's org, so the write is org-scoped server-side (or in-process). */
  orgId: string;
  /** Terminal run status to set (today always `halted`/`failed`/`done`). */
  status: string;
  /** Terminal outcome to set (e.g. `halted`, `window_exhausted`, `ok`, `failed`). */
  outcome: string;
  /**
   * The `WHERE status IN (...)` guard the finalize UPDATE applies, so a run
   * already in a terminal-good / recoverable state is NOT clobbered — preserving
   * EXACTLY-ONCE finalize (a retry re-running this is a no-op: the guard matches
   * no row the second time, so no duplicate finalize or duplicate event).
   */
  fromStatuses: string[];
}

/** The result of a finalize: whether a row moved + the row's spec/project (for the event). */
export interface FinalizeRunResult {
  /** True when the UPDATE matched a row (the run was in a `fromStatuses` state). */
  updated: boolean;
  /** The finalized run's spec_id (for a follow-on event append); undefined when no row moved. */
  specId?: string;
  /** The finalized run's project_id (for a follow-on event append); undefined when no row moved. */
  projectId?: string;
}

/**
 * Plane-split P3c — the run/spec/task LIFECYCLE writes the data-plane workflow
 * still drives directly today (the non-finalize run transitions, the spec status
 * moves, and the subtask/CI/review/merge task rows). Routing these through the
 * seam lets migration `0035` REVOKE the data plane's remaining write grants on
 * `runs` / `specs` / `tasks` — after P3c the data plane writes those tables ONLY
 * via the control plane (mirroring P3b's events/cost_records).
 *
 * Each op carries the run's `orgId` so the control-plane write is org-scoped
 * server-side (the in-process `DirectRunStateWriter` opens the SAME scope). The
 * task ops resolve org from the ambient per-job scope when omitted, exactly like
 * {@link RunStateWriter.append} (the worker sets it with `runWithJobOrgId`).
 */

/** The non-finalize `UPDATE runs` the workflow drives (the `running` transition). */
export interface SetRunStatusInput {
  runId: string;
  /** The owning run's org, so the UPDATE is org-scoped server-side (or in-process). */
  orgId: string;
  /** Status to set (today `running`). */
  status: string;
  /** When true, also set `started_at = now()` (the `running` transition does). */
  setStartedAt: boolean;
}

/** The `UPDATE runs SET pr_url` the draft-PR stage drives. */
export interface SetRunPrUrlInput {
  runId: string;
  orgId: string;
  prUrl: string;
}

/** The `UPDATE specs SET status` the workflow drives (`in_flight` / merge-outcome). */
export interface SetSpecStatusInput {
  specId: string;
  orgId: string;
  status: string;
}

/**
 * The named `tasks` lifecycle transitions, each mapping to ONE fixed UPDATE in
 * `runStateLifecycleSql.ts`:
 *   - `running`                       → status='running', started_at=COALESCE(started_at, now()), ended_at=NULL
 *   - `running_attempt`               → + attempt=$attempt (CI re-poll)
 *   - `running_pending`               → status='running', outcome='pending', ended_at=NULL
 *   - `running_pending_clear_failure` → + failure_kind=NULL
 *   - `started`                       → status='running', started_at=now()
 *   - `done`                          → status='done', outcome=$outcome, ended_at=now()
 *   - `failed`                        → status='failed', outcome='failed', ended_at=now()
 *   - `failed_with_kind`              → + failure_kind=$failureKind
 *   - `cancelled`                     → status='cancelled', outcome='cancelled', ended_at=now()
 */
export type TaskTransition =
  | "running"
  | "running_attempt"
  | "running_pending"
  | "running_pending_clear_failure"
  | "started"
  | "done"
  | "failed"
  | "failed_with_kind"
  | "cancelled";

/** A single task-row status move by `task_id`. */
export interface UpdateTaskInput {
  taskId: string;
  /** Resolve org from the ambient per-job scope when omitted (like {@link RunStateWriter.append}). */
  orgId?: string;
  transition: TaskTransition;
  /** Set for `done` (the persisted outcome). */
  outcome?: string;
  /** Set for `failed_with_kind`. */
  failureKind?: string;
  /** Set for `running_attempt`. */
  attempt?: number;
}

/** The shape of a `tasks` INSERT the workflow drives (subtask / CI / review / merge). */
export interface InsertTaskInput {
  taskId: string;
  runId: string;
  orgId?: string;
  kind: string;
  title: string;
  status: string;
  agentKind: string;
  cli: string;
  model: string | null;
  /** Set on child subtasks (writer/check/audit reference the planner task). */
  parentTaskId?: string;
  /** When true, stamp `started_at = now()` (status `running` rows do). */
  setStartedAt: boolean;
  /** Set on system tasks (CI/review/merge) that carry an attempt counter. */
  attempt?: number;
}

/** The cost-record write the worker drives (mirrors {@link CostRecorder.record}). */
export interface RecordCostInput {
  context: CostRecordContext;
  tokens: TokenUsage;
  rawUsage: Record<string, unknown>;
}

/**
 * The run-end cost RECONCILE the worker drives (mirrors
 * {@link CostRecorder.apportionRunCost}). The recorder has already resolved the
 * run-level dollar total + its basis (credit-drawdown precedence over ccusage —
 * PROJECT_BRIEF §4); this carries that resolved total so the apportioning
 * SELECT + per-row UPDATEs run server-side (control plane) under the run's org
 * scope, never as a direct `cost_records` UPDATE from the de-privileged data
 * plane (migration 0031 dropped that grant).
 */
export interface ReconcileCostInput {
  runId: string;
  /** The owning run's org, so the reconcile batch is org-scoped server-side (or in-process). */
  orgId: string;
  /** The run-level dollar total to apportion across the run's rows by token share. */
  totalCostUsd: number;
  /** The cost basis to stamp each repriced row with. */
  basis: "ccusage" | "credits";
}

/**
 * The worker's run-state write surface. The worker (and the workflow it drives)
 * route every tenant run-state write through this seam so a deployment can move
 * those writes behind the control plane (remote) or keep them in-process
 * (direct) WITHOUT changing what gets written.
 *
 * Also IS an {@link EventStore}, so a writer-backed event store can be injected
 * straight into the workflow + the cost recorder with no extra adapter — every
 * workflow `appendEvent` then routes through the same seam.
 */
export interface RunStateWriter extends EventStore {
  /** Append one timeline event (the {@link EventStore} surface). */
  append(input: AppendEventInput): Promise<void>;

  /** Insert one cost_records row (+ its `cost.resolved` event), as {@link CostRecorder.record}. */
  recordCost(input: RecordCostInput): Promise<RecordedCost>;

  /**
   * Apportion a run-level dollar total across the run's cost_records rows by
   * token share under the run's org scope, returning rows repriced. This is the
   * run-end reconcile/back-fill (credit-drawdown or ccusage); routing it through
   * the seam keeps the data plane from UPDATEing cost_records directly.
   */
  reconcileCost(input: ReconcileCostInput): Promise<{ updated: number }>;

  /**
   * Finalize a run into a terminal state under its org scope, returning whether a
   * row moved (so the caller can conditionally append the matching `run.*` event).
   * Exactly-once: the `fromStatuses` guard makes a re-run a no-op.
   */
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult>;

  // --- Plane-split P3c: the run/spec/task lifecycle writes. ---

  /** The non-finalize `UPDATE runs` (the `running` transition). */
  setRunStatus(input: SetRunStatusInput): Promise<void>;

  /** The `UPDATE runs SET pr_url` after the draft PR is opened. */
  setRunPrUrl(input: SetRunPrUrlInput): Promise<void>;

  /** The `UPDATE specs SET status` (`in_flight` / merge-outcome). */
  setSpecStatus(input: SetSpecStatusInput): Promise<void>;

  /**
   * Cancel the vestigial queued `plan` task the spec-run trigger pre-created (the
   * workflow opens its own planner task). A guarded bulk UPDATE; org from the
   * ambient per-job scope.
   */
  supersedeQueuedPlannerTask(input: { runId: string; orgId?: string }): Promise<void>;

  /** Insert one `tasks` row (subtask / CI / review / merge). */
  insertTask(input: InsertTaskInput): Promise<void>;

  /** Move one `tasks` row through a named lifecycle transition by `task_id`. */
  updateTask(input: UpdateTaskInput): Promise<void>;
}
