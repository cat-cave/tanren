import { z } from "zod";

export const JobKind = z.enum([
  // canonical run-stage values
  "hello",
  "phase1_fixture",
  "phase2_easy",
  "phase2_medium",
  "ci_poll",
  "recovery_revise",
  "recovery_replan",
  "recovery_rollback",
  // in-loop deterministic gate-check stage
  "gate",
  // review→merge completion stages (run AFTER CI passes)
  "review",
  "merge",
  // task-kind values that are also enqueued as jobs
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  "demo",
  "forge",
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum([
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  "cancelled",
  // terminal state for a genuinely-poisoned job (a deterministic, repeating
  // non-transient failure proving the job itself is unprocessable). NOT reached on
  // an attempt count: a lease-expired job is requeued indefinitely (transient
  // recovery), and surfaces a LOUD `job.lease_expired` infra signal — never a
  // silent drop. Kept in the state machine for a future poison-pill classifier.
  "dead_letter",
]);
export type JobStatus = z.infer<typeof JobStatus>;

const allowedJobTransitions: Record<JobStatus, ReadonlyArray<JobStatus>> = {
  // lease recovery: a reaper requeues an expired `running` job, so
  // running → queued is a legal transition (crashed-worker recovery).
  queued: ["claimed", "cancelled", "running"],
  claimed: ["running", "cancelled"],
  running: ["done", "failed", "cancelled", "queued", "dead_letter"],
  done: [],
  failed: ["queued", "dead_letter"],
  cancelled: [],
  dead_letter: [],
};

export function isAllowedJobTransition(from: JobStatus, to: JobStatus): boolean {
  return allowedJobTransitions[from].includes(to);
}

export class IllegalJobTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
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
