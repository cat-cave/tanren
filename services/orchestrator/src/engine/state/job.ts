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
  // P3-0005 in-loop deterministic gate-check stage
  "gate",
  // P3-0008 review→merge completion stages (run AFTER CI passes)
  "review",
  "merge",
  // Phase 0/1 task-kind values that are also enqueued as jobs today
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
  // P3-0028: terminal state for a job whose bounded re-claim budget is
  // exhausted. A dead-lettered job is never re-claimed; it surfaces a
  // `job.dead_lettered` lifecycle event for operator triage.
  "dead_letter",
]);
export type JobStatus = z.infer<typeof JobStatus>;

const allowedJobTransitions: Record<JobStatus, ReadonlyArray<JobStatus>> = {
  // P3-0028 lease recovery: a reaper requeues an expired `running` job, so
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
