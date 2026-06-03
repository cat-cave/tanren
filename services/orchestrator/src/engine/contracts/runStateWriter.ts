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
import type { ActorContext } from "../../auth/schemas.js";
import type { CreateSpecInput, CreateSpecRunInput, SpecContract, SpecRunContract } from "../workflow/projectSpec.js";

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

// --- Change-percolation (the DagWalker loop's §2c run-column writes). ---
//
// The change-percolation coordinator (part of the DagWalker subscriber loop) drives
// a handful of bespoke `UPDATE runs SET <jsonb column>` writes the de-privileged data
// plane can no longer run directly (migration 0035). Each carries the run's explicit
// org (the coordinator resolves it system-scoped) so the control-plane write is
// org-scoped server-side. WHAT GETS WRITTEN is byte-identical to the in-process SQL.

/** Re-point a speculative run's dynamic base onto the rebuilt integration branch. */
export interface SetRunSpeculativeBaseInput {
  runId: string;
  orgId: string;
  speculativeBase: string;
}

/** Stamp the percolation re-execution run id onto the dependent run's in-flight marker. */
export interface SetRunPercolationReexecIdInput {
  runId: string;
  orgId: string;
  reexecRunId: string;
}

/** Clear the in-flight percolation marker once a percolation settled (absorbed/replan). */
export interface ClearRunPercolationPendingInput {
  runId: string;
  orgId: string;
}

/** Merge ONE ancestor's re-gated-clean (ABSORBED) SHA + verdict into `verified_ancestor_shas`. */
export interface MergeRunVerifiedAncestorShaInput {
  runId: string;
  orgId: string;
  ancestorSpecId: string;
  /** The pre-serialized `{ sha, reviewVerdict? }` jsonb value for this ancestor. */
  entryJson: string;
}

/**
 * The `UPDATE specs SET metadata` the autonomous INTAKE drives when it stamps
 * discovery provenance onto an auto-routed spec (`writeProvenance`). A direct
 * `UPDATE specs` from the de-privileged data plane is rejected (migration 0035),
 * so the intake routes this through the control plane. The caller has already
 * merged + serialized the full metadata blob (the existing `writeProvenance`
 * read-merge-write), so this carries the final JSON to write verbatim.
 */
export interface SetSpecMetadataInput {
  specId: string;
  orgId: string;
  /** The fully-merged metadata JSON to write (`::jsonb`). */
  metadataJson: string;
}

/** The `UPDATE specs SET status` the workflow drives (`in_flight` / merge-outcome). */
export interface SetSpecStatusInput {
  specId: string;
  orgId: string;
  status: string;
  /**
   * Optional idempotency guard: when set, the UPDATE applies only when the spec's
   * current status is NOT one of these (`WHERE status <> ALL(...)`). The merge
   * coordinator's `merged` finalize + its conflict reopen carry this so a spec
   * already in a terminal-good state (`merged`/`done`) is not clobbered —
   * preserving the in-process guard exactly. Omitted ⇒ an unguarded set (the
   * workflow's `in_flight` transition, unchanged).
   */
  notFromStatuses?: string[];
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
 * Plane-split (autonomy loops): the run-CREATE write the autonomous loops drive —
 * the DagWalker enqueuing a ready spec, the merge coordinator re-executing a
 * conflicting spec, and the intake re-running a routed spec. Unlike the run
 * EXECUTOR (which only UPDATES/finalizes an EXISTING run), these loops CREATE a
 * queued run — a single atomic multi-table transaction (INSERT runs + UPDATE
 * specs + INSERT tasks + INSERT job_queue + 2 events) that `createQueuedRunFromSpec`
 * performs. The de-privileged data plane can no longer write `runs`/`specs`/`tasks`/
 * `events` directly (migrations 0031/0035), so this op routes the whole transaction
 * through the control plane.
 *
 * Carries the resolved `actor` (a `platform:admin` actor whose `orgId` the loop
 * resolved system-scoped) so the server-side `createQueuedRunFromSpec` runs the
 * SAME org-scoped transaction the loop would have run in-process.
 */
export interface CreateQueuedRunInput {
  input: CreateSpecRunInput;
  actor: ActorContext;
}

/**
 * Plane-split (autonomy loops): the spec-CREATE write the autonomous INTAKE drives
 * — an `auto_routable` ingested item whose triage routes a brand-new spec into the
 * DAG (`createSpec`). A direct `INSERT INTO specs` from the de-privileged data
 * plane is rejected (migration 0035), so the auto-route insert routes through the
 * control plane. Carries the resolved `actor` so the server-side `createSpec` runs
 * under the SAME org scope.
 */
export interface CreateSpecRemoteInput {
  input: CreateSpecInput;
  actor: ActorContext;
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

  /** The `UPDATE specs SET metadata` (the intake's discovery-provenance stamp). */
  setSpecMetadata(input: SetSpecMetadataInput): Promise<void>;

  // --- Change-percolation (the DagWalker loop's §2c run-column writes). ---

  /** Re-point a speculative run's dynamic base onto the rebuilt integration branch. */
  setRunSpeculativeBase(input: SetRunSpeculativeBaseInput): Promise<void>;

  /** Stamp the percolation re-execution run id onto the dependent's in-flight marker. */
  setRunPercolationReexecId(input: SetRunPercolationReexecIdInput): Promise<void>;

  /** Clear the in-flight percolation marker once a percolation settled. */
  clearRunPercolationPending(input: ClearRunPercolationPendingInput): Promise<void>;

  /** Merge ONE ancestor's absorbed SHA + verdict into `verified_ancestor_shas`. */
  mergeRunVerifiedAncestorSha(input: MergeRunVerifiedAncestorShaInput): Promise<void>;

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

  // --- Autonomy loops: the run/spec CREATE writes (explicit-actor, multi-table). ---

  /**
   * Create a queued run from a ready spec (the DagWalker enqueue, the merge
   * coordinator's conflict re-execution, the intake re-run). The full atomic
   * `createQueuedRunFromSpec` transaction, run under the actor's org scope.
   */
  createQueuedRun(input: CreateQueuedRunInput): Promise<SpecRunContract>;

  /**
   * Create a new spec (the autonomous intake auto-route insert). The
   * `createSpec` insert, run under the actor's org scope.
   */
  createSpec(input: CreateSpecRemoteInput): Promise<SpecContract>;
}
