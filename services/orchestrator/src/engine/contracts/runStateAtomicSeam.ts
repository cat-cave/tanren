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
