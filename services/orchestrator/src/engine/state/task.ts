import { z } from "zod";

export const TaskKind = z.enum([
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  // review→merge completion stages (run AFTER CI passes)
  "review",
  "merge",
  "demo",
  "forge",
  // SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the new per-spec stages —
  // triage (findings → root-cause work items) + convergence (progress/stall read).
  "triage",
  "convergence",
]);
export type TaskKind = z.infer<typeof TaskKind>;

// The canonical task-status vocabulary (v21). `done` is the success terminal a
// task ends at; `failed`/`cancelled` are the unhappy terminals. This is the one
// vocabulary — there is no second set to normalize.
export const TaskStatus = z.enum(["queued", "claimed", "running", "done", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// The task-outcome vocabulary. `ok` is the generic success outcome a `done` task
// carries (the review/merge stages write it); `pending` marks an in-flight CI
// re-poll; the rest name a specific failure mode.
export const TaskOutcome = z.enum([
  "passed",
  "ok",
  "pending",
  "failed",
  "rejected_by_checker",
  "rejected_by_auditor",
  "timed_out",
  "crashed",
  "window_exhausted",
  "cancelled",
]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

const allowedTaskTransitions: Record<TaskStatus, ReadonlyArray<TaskStatus>> = {
  queued: ["claimed", "cancelled", "running"],
  claimed: ["running", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function isAllowedTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskTransitions[from].includes(to);
}

export class IllegalTaskTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`illegal task transition: ${from} -> ${to}`);
  }
}

export function transitionTask(from: TaskStatus, to: TaskStatus): asserts to is TaskStatus {
  if (!isAllowedTaskTransition(from, to)) {
    throw new IllegalTaskTransitionError(from, to);
  }
}

export function listAllowedTaskTransitions(from: TaskStatus): ReadonlyArray<TaskStatus> {
  return allowedTaskTransitions[from];
}
