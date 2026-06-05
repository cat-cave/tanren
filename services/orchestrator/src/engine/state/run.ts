import { z } from "zod";

// Source-of-truth Zod enums for run state. The committed SQL CHECK
// constraints in db/migrations/0002 are generated from these via
// scripts/generate-state-checks.mjs and verified by the drift check.

// The single, canonical run-status vocabulary (v21). A successful run ends at
// `completed` — there is NO second `done` value, so every producer/consumer reads
// one vocabulary.
export const RunStatus = z.enum(["queued", "running", "halted", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

// The run-outcome vocabulary. `ok` is the generic success outcome a completed run
// carries; the `phase*_complete` / escape-hatch / exhaustion values name WHY a run
// ended. (The dead Phase-0/1 `hello_world_complete` + `pending` outcomes were
// pruned in v21 — nothing wrote them.)
export const RunOutcome = z.enum([
  "ok",
  "hello_complete",
  "phase1_fixture_complete",
  "phase2_easy_complete",
  "phase2_medium_complete",
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  "window_exhausted",
  "cancelled",
  "failed",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

// Legal status transitions per the spec. A successful run lands at `completed`.
const allowedRunTransitions: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  queued: ["running"],
  running: ["halted", "completed", "failed", "cancelled"],
  halted: ["running", "cancelled"],
  completed: [],
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
