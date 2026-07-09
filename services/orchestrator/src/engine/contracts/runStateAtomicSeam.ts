// Task #48 (run/spec atomicity sweep) — the RUN-LEVEL + SPEC-LEVEL atomic
// seam types. Split from `runStateWriter.ts` to keep that file under the
// 500-line architecture cap; re-exported from `./index.ts` so callers see
// one `contracts` namespace.
//
// The RUN-LEVEL mirror of `UpdateTaskWithEventInput` (task #39) pairs a
// terminal `runs` finalize with the matching terminal `run.*` event in ONE
// org-scoped transaction (backed by the partial unique index
// `events_run_terminal_unique` for idempotency).
//
// The SPEC-LEVEL variant pairs a guarded `UPDATE specs SET status` with the
// matching spec-disposition event. Unlike run/task, the spec side admits
// NON-TERMINAL events (`dag.spec.redriven` recurs per attempt;
// `dag.spec.needs_attention` re-fires per incident — Plan §3), so there is
// NO partial unique index + no `appendIfAbsent` dedupe on the spec side.

import type { AppendEventInput } from "../eventStore.js";
import type { FinalizeRunInput, SetSpecStatusInput } from "./runStateWriter.js";

/**
 * The atomic terminal-run input (task #48 — RUN-LEVEL mirror of
 * `UpdateTaskWithEventInput`). Pairing enforced by `runPairSchema`
 * (ok→run.completed, halted/window_exhausted/convergence_stalled/failed→run.failed,
 * cancelled→run.cancelled). Empty `event.specId`/`event.projectId` defer to the
 * UPDATE's RETURNING (the worker failure-path doesn't know them ahead of finalize).
 */
export interface FinalizeRunWithEventInput {
  finalize: FinalizeRunInput;
  event: AppendEventInput;
}

/** Outcome of an atomic terminal-run + terminal-event apply (task #48). */
export interface FinalizeRunWithEventOutcome {
  /** True when the UPDATE matched a row (the run was in a `fromStatuses` state). */
  updated: boolean;
  /** True when the event was already terminal (this call deduped). */
  alreadyTerminal: boolean;
  /** The finalized run's spec_id (the row UPDATE's RETURNING). */
  specId?: string;
  /** The finalized run's project_id (the row UPDATE's RETURNING). */
  projectId?: string;
}

/**
 * The atomic spec-status + event input (task #48 — SPEC-LEVEL mirror).
 * Admits NON-TERMINAL events (`dag.spec.redriven` recurs per attempt;
 * `dag.spec.needs_attention` re-fires per incident) so no partial unique
 * index + no `appendIfAbsent` dedupe on the spec side (Plan §3).
 */
export interface UpdateSpecWithEventInput {
  spec: SetSpecStatusInput;
  event: AppendEventInput;
}

/** The outcome of an atomic spec-status flip + event apply. */
export interface UpdateSpecWithEventOutcome {
  /** True when the guarded UPDATE matched a row. */
  flipped: boolean;
  /** Reserved for parity; always false on the spec side (no partial unique index). */
  alreadyTerminal: boolean;
}

/**
 * Audit finding #3 — the WINDOW-PAUSE RESUME atomic seam. The pause/resume
 * doctrine needs BOTH writes to land or fail together: the run flip
 * (`paused → halted` + `run.resumed`) AND the spec flip (`in_flight → open` +
 * `dag.spec.redriven`). Two sequential atomic seams (the prior shape)
 * stranded a run in `runs.status=halted` + `specs.status=in_flight` whenever
 * a crash landed between them — the prober's `WHERE status='paused'` poll
 * never re-matched the run and the walker never re-drove the `in_flight`
 * spec. This input bundles all four writes through ONE org-scoped
 * transaction so a partial apply is impossible.
 *
 * Same pairing-schema discipline as `finalizeRunWithEvent` /
 * `updateSpecWithEvent`: the run side carries the `paused → halted` finalize
 * + `run.resumed` event; the spec side carries the `in_flight → open` flip
 * + `dag.spec.redriven` event. Both pair-shapes are validated at the seam
 * via `resumePausedRunPairSchema` before any DB I/O.
 */
export interface ResumePausedRunAtomicInput {
  finalize: FinalizeRunInput;
  resumedEvent: AppendEventInput;
  spec: SetSpecStatusInput;
  redrivenEvent: AppendEventInput;
}

/** The outcome of an atomic window-pause resume. Pairs the per-seam outcomes
 * the existing run-/spec-level appliers already surface. */
export interface ResumePausedRunAtomicOutcome {
  /** True when the run-finalize UPDATE matched a row (`paused`-guarded). */
  runFinalized: boolean;
  /** True when the `run.resumed` INSERT was deduped by the partial unique index. */
  runEventAlreadyTerminal: boolean;
  /** True when the spec-status UPDATE matched a row (`notFromStatuses`-guarded). */
  specFlipped: boolean;
  /** The resumed run's spec_id (the row UPDATE's RETURNING). */
  specId?: string;
  /** The resumed run's project_id (the row UPDATE's RETURNING). */
  projectId?: string;
}

/**
 * apex v86 / PR #724 follow-up plane-split fix: the ATOMIC post-PR-open block
 * (`github.pr.created` + `merge_queue` INSERT + optional `merge.scheduled`) that
 * `mergeQueueEarlyEnqueueSeam` drives after a successful draft-PR open. Routed
 * through {@link RunStateWriter} so the de-privileged data plane never opens
 * `PgEventStore` on its pool (baseline REVOKE → `permission denied for table events`).
 */
export interface RecordDraftPrCreatedInput {
  orgId: string;
  runId: string;
  specId: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  /** The PR base branch (immediate ancestor head when stacked, else default). */
  baseBranch: string;
  prUrl: string;
  prNumber: number;
}

/** Outcome of the post-PR-open atomic block (`created` from the merge_queue INSERT). */
export interface RecordDraftPrCreatedOutcome {
  /** False when the partial unique index already held a queue row for this run. */
  created: boolean;
}
