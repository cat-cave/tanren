import { z } from "zod";

// Source-of-truth Zod enums for run state. The committed SQL CHECK
// constraints in db/migrations/0002 are generated from these via
// scripts/generate-state-checks.mjs and verified by the drift check.

export const RunStatus = z.enum([
  // Phase 2 canonical values
  "queued",
  "running",
  "halted",
  "completed",
  "failed",
  "cancelled",
  // Phase 0/1 historical values still present in the database
  "done",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunOutcome = z.enum([
  // Phase 2 canonical outcomes
  "hello_complete",
  "phase1_fixture_complete",
  "phase2_easy_complete",
  "phase2_medium_complete",
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  "window_exhausted",
  "cancelled",
  // Phase 0/1 historical outcomes still present in the database
  "hello_world_complete",
  "ok",
  "failed",
  "pending",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

// Legal status transitions per the spec. Including legacy "done" so the
// existing fixture flow keeps working until callers migrate to "completed".
const allowedRunTransitions: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  queued: ["running"],
  running: ["halted", "completed", "failed", "cancelled", "done"],
  halted: ["running", "cancelled"],
  completed: [],
  done: [],
  failed: [],
  cancelled: [],
};

export type RunTransition = { from: RunStatus; to: RunStatus };

export function isAllowedRunTransition(from: RunStatus, to: RunStatus): boolean {
  return allowedRunTransitions[from].includes(to);
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`illegal run transition: ${from} -> ${to}`);
  }
}

// transitionRun fails at runtime on illegal transitions; the overload
// shape lets the compiler narrow that the to/from pair was checked. Callers
// should pass values whose types are already RunStatus (decoded by the
// repository) so the compiler proves they are valid enum members.
export function transitionRun(from: RunStatus, to: RunStatus): asserts to is RunStatus {
  if (!isAllowedRunTransition(from, to)) {
    throw new IllegalRunTransitionError(from, to);
  }
}

export function listAllowedRunTransitions(from: RunStatus): ReadonlyArray<RunStatus> {
  return allowedRunTransitions[from];
}
