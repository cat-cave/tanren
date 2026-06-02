import { listEventNames, type EventName } from "../events/index.js";
import type { Severity } from "./schemas.js";

// P2A-0017: map every event name in the P2A-0007 registry to a default
// severity. The matrix UI consumes this map to render the event row's
// default level; the dispatcher consults it at fire time to decide whether
// a route's minSeverity floor is met.
//
// Severity taxonomy:
//   ok    - happy-path completion that an operator wants to celebrate
//           (run.completed, ci.passed, github.pr.merged).
//   info  - normal-flight progress that some operators want, most don't
//           (lifecycle started/queued, subtask progress, redaction audit).
//   warn  - degraded but recoverable (ci.failed, checker rejection, github
//           failures, planner re-request) — usually surfaces in dashboards
//           regardless of opt-in.
//   fail  - run-halting / unattributable / lost-work signals (run.failed,
//           run.halted, cost.unattributable, task.failed). These should be
//           reachable on every operator's pager-style channel by default.
//
// A few events are not operator-actionable (allocator internals,
// notification.* meta-events) and stay at `info` so the matrix UI defaults
// the rows off without forcing the operator to discover them.

const SEVERITY_OVERRIDES: Partial<Record<EventName, Severity>> = {
  // Run lifecycle
  "run.queued": "info",
  "run.started": "info",
  "run.completed": "ok",
  "run.failed": "fail",

  // Task lifecycle
  "task.queued": "info",
  "task.started": "info",
  "task.completed": "info",
  "task.failed": "warn",

  // Planner
  "planner.started": "info",
  "planner.completed": "info",
  "planner.failed": "warn",
  "planner.subtasks.emitted": "info",

  // Writer
  "writer.started": "info",
  "writer.completed": "info",
  "writer.failed": "warn",
  "writer.subtask.started": "info",
  "writer.subtask.completed": "info",
  "writer.subtask.failed": "warn",

  // Checker
  "checker.started": "info",
  "checker.completed": "info",
  "checker.failed": "warn",
  // dispatcher promotes to warn when passed=false
  "checker.verdict": "info",

  // Auditor
  "auditor.started": "info",
  "auditor.completed": "info",
  "auditor.failed": "warn",
  // dispatcher promotes to warn when passed=false
  "auditor.verdict": "info",

  // Runner / allocator
  "runner.allocated": "info",
  "runner.released": "info",
  "runner.failed": "warn",
  "allocator.requested": "info",
  "allocator.allocated": "info",
  "allocator.failed": "warn",

  // Workspace
  "workspace.prepared": "info",
  "workspace.git_captured": "info",
  "workspace.failed": "warn",

  // Credentials
  "credential.requested": "info",
  "credential.loaded": "info",
  "credential.failed": "warn",

  // Cost
  "cost.resolved": "info",
  "cost.failed": "warn",
  "cost.unattributable": "fail",

  // GitHub integration
  "github.branch.pushed": "info",
  "github.pr.created": "ok",
  "github.pr.ready": "ok",
  "github.pr.merged": "ok",
  "github.failed": "warn",

  // CI
  "ci.started": "info",
  "ci.passed": "ok",
  "ci.failed": "warn",

  // Post-merge auto-issue creation (tempering.md dim A): a post-merge regression
  // on default_branch is a real change-failure (fail); auto-opening its tracking
  // issue is an operator-actionable signal (warn).
  "merge.post_merge_failed": "fail",
  "issue.opened": "warn",

  // Phase 1 fixture
  "phase1.fixture.started": "info",
  "phase1.fixture.ci_pending": "info",
  "phase1.fixture.completed": "ok",
  "phase1.fixture.failed": "fail",

  // Review
  "review.requested": "info",
  "review.approved": "ok",
  "review.auto_approved": "ok",
  "review.changes_requested": "warn",

  // Notification meta — opted off by default; severity floor will mask them
  // even on routes that accidentally enable them, since the dispatcher does
  // not re-emit notification.* into its own pipeline.
  "notification.enqueued": "info",
  "notification.sent": "info",
  "notification.failed": "warn",

  // Hello
  "hello.started": "info",
  "hello.ssh_started": "info",
  "hello.ssh_completed": "info",
  "hello.completed": "ok",

  // Redaction audit — info, never raised, but auditable surface.
  "redaction.raw_access": "info",

  // P2B-0008 recovery lineage — operator-initiated recovery progress; info so
  // the matrix rows default off but the records stay auditable.
  "recovery.revise_routed": "info",
  "recovery.replan_queued": "info",
  "recovery.rollback_queued": "info",
  "recovery.inspection_opened": "info",

  // Tanren-method benchmark accept tier — passing the hidden oracle is a happy
  // path (ok); failing it is a real post-merge change-failure that an operator
  // running an experiment wants surfaced (warn).
  "benchmark.accept.passed": "ok",
  "benchmark.accept.failed": "warn",
};

// Sealed: every EventName must have a default severity. Missing keys would
// be a silent `info` fallback — the test suite forbids that to keep the
// matrix UI honest.
export const eventDefaultSeverity: Record<EventName, Severity> = freezeDefaults();

function freezeDefaults(): Record<EventName, Severity> {
  const result = {} as Record<EventName, Severity>;
  for (const name of listEventNames()) {
    const override = SEVERITY_OVERRIDES[name];
    result[name] = override ?? "info";
  }
  return result;
}

export function defaultSeverityFor(eventName: EventName): Severity {
  return eventDefaultSeverity[eventName];
}
