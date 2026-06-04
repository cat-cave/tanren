// The leaf pass/fail/pending predicates over GitHub check runs + commit statuses,
// extracted from `ciPolling.ts` so `evaluateCiObservation` reads against a small
// shared vocabulary. Pure; no I/O. A check run is FAILED only when it has
// COMPLETED with a non-success conclusion (an in-flight run is pending, never a
// failure); a commit status is failed on `failure`/`error`, pending on `pending`.

import { type GitHubCheckRun, type GitHubCommitStatus } from "../providers/github.js";

const successfulCheckConclusions = new Set(["success", "neutral", "skipped"]);

export function isFailedCheckRun(check: GitHubCheckRun): boolean {
  return check.status === "completed" && !successfulCheckConclusions.has(check.conclusion ?? "");
}

export function isPendingCheckRun(check: GitHubCheckRun): boolean {
  return check.status !== "completed";
}

export function isFailedStatus(status: GitHubCommitStatus): boolean {
  return status.state === "failure" || status.state === "error";
}

export function isPendingStatus(status: GitHubCommitStatus): boolean {
  return status.state === "pending";
}
