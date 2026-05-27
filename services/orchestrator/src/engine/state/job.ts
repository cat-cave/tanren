import { z } from "zod";

export const JobKind = z.enum([
  // Phase 2 canonical values
  "hello",
  "phase1_fixture",
  "phase2_easy",
  "phase2_medium",
  "ci_poll",
  "recovery_revise",
  "recovery_replan",
  "recovery_rollback",
  // Phase 0/1 task-kind values that are also enqueued as jobs today
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  "demo",
  "forge"
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum([
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  "cancelled"
]);
export type JobStatus = z.infer<typeof JobStatus>;

const allowedJobTransitions: Record<JobStatus, ReadonlyArray<JobStatus>> = {
  queued: ["claimed", "cancelled", "running"],
  claimed: ["running", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: []
};

export function isAllowedJobTransition(from: JobStatus, to: JobStatus): boolean {
  return allowedJobTransitions[from].includes(to);
}

export class IllegalJobTransitionError extends Error {
  constructor(readonly from: JobStatus, readonly to: JobStatus) {
    super(`illegal job transition: ${from} -> ${to}`);
  }
}

export function transitionJob(from: JobStatus, to: JobStatus): asserts to is JobStatus {
  if (!isAllowedJobTransition(from, to)) {
    throw new IllegalJobTransitionError(from, to);
  }
}

export function listAllowedJobTransitions(from: JobStatus): ReadonlyArray<JobStatus> {
  return allowedJobTransitions[from];
}
