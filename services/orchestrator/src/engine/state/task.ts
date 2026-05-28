import { z } from "zod";

export const TaskKind = z.enum([
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  // P3-0008 review→merge completion stages (run AFTER CI passes)
  "review",
  "merge",
  "demo",
  "forge"
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum([
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  // Phase 2 canonical "cancelled" value kept alongside legacy "done"
  "cancelled"
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskOutcome = z.enum([
  "passed",
  "failed",
  "rejected_by_checker",
  "rejected_by_auditor",
  "timed_out",
  "crashed",
  "window_exhausted",
  "cancelled",
  // Phase 0/1 historical outcomes still present in the database
  "ok",
  "pending"
]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

const allowedTaskTransitions: Record<TaskStatus, ReadonlyArray<TaskStatus>> = {
  queued: ["claimed", "cancelled", "running"],
  claimed: ["running", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: []
};

export function isAllowedTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskTransitions[from].includes(to);
}

export class IllegalTaskTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
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
