// NATIVE EXTERNAL-CHECK EVALUATOR. The native gate is the merge authority, so Tanren
// no longer READS forge check-runs to GATE a merge. The ONE place a forge check-status
// is still interpreted is the post-merge regression watcher: after a PR merges onto
// `default_branch`, the watcher reads that branch's external CI (`readBranchChecks`) and
// reduces it here to decide whether to auto-open a tracking issue. This is a pure reducer
// over a forge check snapshot — no polling, no merge gating, no run-state writes.
//
// (It is also the future external-check escape hatch: a project that wants Tanren to
// observe a forge check it does not run itself can reuse this evaluator + `readBranchChecks`.)

import type { GitHubCheckRun, GitHubCommitStatus, GitHubPullRequestChecks } from "../providers/github.js";
import type { EvaluateCiObservationOptions } from "./ciQuarantine.js";
import { isFailedCheckRun, isFailedStatus, isPendingCheckRun, isPendingStatus } from "./ciCheckPredicates.js";

export type CiObservationStatus = "pending" | "passed" | "failed";
export type CiObservationReason = "no_checks" | "checks_pending" | "all_checks_passed" | "check_failed";

export interface CiObservation {
  status: CiObservationStatus;
  reason: CiObservationReason;
  headSha: string;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  failingChecks: Array<{
    kind: "check_run" | "commit_status";
    name: string;
    state: string;
    url?: string;
  }>;
  pendingChecks: Array<{
    kind: "check_run" | "commit_status";
    name: string;
    state: string;
    url?: string;
  }>;
}

/**
 * Reduce a forge check snapshot to a single observation. A quarantined check is excluded
 * from the failure verdict (CI-intelligence). When branch protection declares required
 * contexts the verdict gates on THOSE only: an optional check failing/pending does not
 * block, and a required context that has not reported keeps the result pending. Pure.
 */
export function evaluateCiObservation(
  checks: GitHubPullRequestChecks,
  options: EvaluateCiObservationOptions = {},
): CiObservation {
  const quarantined = options.quarantinedCheckNames ?? new Set<string>();
  const required = checks.requiredContexts;
  const gated = required !== undefined && required.length > 0;
  const requiredSet = new Set(required ?? []);
  const allFailing = [
    ...checks.checkRuns
      .filter(
        (check) =>
          isFailedCheckRun(check) ||
          (checks.requiredCheckAppIds?.[check.name] !== undefined &&
            check.appId !== checks.requiredCheckAppIds[check.name]),
      )
      .map((check) => ({
        kind: "check_run" as const,
        name: check.name,
        state:
          checks.requiredCheckAppIds?.[check.name] !== undefined &&
          check.appId !== checks.requiredCheckAppIds[check.name]
            ? "wrong_app_identity"
            : (check.conclusion ?? check.status),
        url: check.url,
      }))
      .filter((check) => !quarantined.has(check.name) || (gated && requiredSet.has(check.name))),
    ...checks.statuses.filter(isFailedStatus).map((status) => ({
      kind: "commit_status" as const,
      name: status.context,
      state: status.state,
      url: status.url,
    })),
  ].filter((check) => !quarantined.has(check.name) || (gated && requiredSet.has(check.name)));
  const allPending = [
    ...checks.checkRuns.filter(isPendingCheckRun).map((check) => ({
      kind: "check_run" as const,
      name: check.name,
      state: check.status,
      url: check.url,
    })),
    ...checks.statuses.filter(isPendingStatus).map((status) => ({
      kind: "commit_status" as const,
      name: status.context,
      state: status.state,
      url: status.url,
    })),
  ];

  // Required-check awareness. When branch protection declares required contexts, the
  // verdict is gated on THOSE only: an optional check failing/pending does not block,
  // and a required context that has not reported yet keeps the result pending.
  const failingChecks = gated ? allFailing.filter((check) => required.includes(check.name)) : allFailing;
  const pendingChecks = gated ? allPending.filter((check) => required.includes(check.name)) : allPending;
  const missingRequired = gated ? missingRequiredContexts(required, checks) : [];

  const observed = checks.checkRuns.length + checks.statuses.length;
  let status: CiObservationStatus;
  let reason: CiObservationReason;
  if (failingChecks.length > 0) {
    status = "failed";
    reason = "check_failed";
  } else if (gated) {
    // Required gating: pass only when every required context is present + green.
    if (pendingChecks.length > 0 || missingRequired.length > 0) {
      status = "pending";
      reason = "checks_pending";
    } else {
      status = "passed";
      reason = "all_checks_passed";
    }
  } else if (observed === 0) {
    status = "pending";
    reason = "no_checks";
  } else if (pendingChecks.length > 0) {
    status = "pending";
    reason = "checks_pending";
  } else {
    status = "passed";
    reason = "all_checks_passed";
  }

  // Surface still-unreported required contexts as pending so the consumer can show
  // exactly what is outstanding.
  const pendingWithMissing = [
    ...pendingChecks,
    ...missingRequired.map((name) => ({ kind: "commit_status" as const, name, state: "expected" })),
  ];

  return {
    status,
    reason,
    headSha: checks.head.sha,
    checkRuns: checks.checkRuns,
    statuses: checks.statuses,
    failingChecks,
    pendingChecks: pendingWithMissing,
  };
}

function missingRequiredContexts(required: string[], checks: GitHubPullRequestChecks): string[] {
  const present = new Set<string>([
    ...checks.checkRuns
      .filter(
        (check) =>
          checks.requiredCheckAppIds?.[check.name] === undefined ||
          check.appId === checks.requiredCheckAppIds[check.name],
      )
      .map((check) => check.name),
    ...checks.statuses
      .filter((status) => checks.requiredCheckAppIds?.[status.context] === undefined)
      .map((status) => status.context),
  ]);
  return required.filter((name) => !present.has(name));
}
