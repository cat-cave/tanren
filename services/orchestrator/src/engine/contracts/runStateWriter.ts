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
  /** Terminal outcome to set (e.g. `halted`, `quota_exceeded`, `ok`, `failed`). */
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
}
