import { listEventNames, type EventName } from "../events/index.js";
import type { Severity } from "./schemas.js";

// Map every event name in the registry to a default
// severity. The matrix UI consumes this map to render the event row's
// default level; the dispatcher consults it at fire time to decide whether
// a route's minSeverity floor is met.
//
// Severity taxonomy:
//   ok    - happy-path completion that an operator wants to celebrate
//           (run.completed, github.pr.merged, review.approved).
//   info  - normal-flight progress that some operators want, most don't
//           (lifecycle started/queued, subtask progress, the per-tier native
//           gate results gate.passed/gate.failed, redaction audit).
//   warn  - degraded but recoverable (task.failed, checker rejection, github
//           failures, planner re-request) — usually surfaces in dashboards
//           regardless of opt-in.
//   fail  - run-halting / lost-work signals (run.failed, cost.unattributed,
//           task.failed). The persisted run status may be `halted` while the
//           terminal event operators receive is `run.failed`. These should be
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

  // A successful admin posture transition is ordinary governance audit history.
  "governance.audit_posture.updated": "info",

  // Native gate (in-loop, per-tier, exit-code driven). These fire on EVERY tier
  // evaluation of EVERY writer iteration — routine trajectory noise, NOT per-event
  // operator signals — so they stay at `info` (the matrix row defaults off; an
  // operator debugging a run can opt in). The operator-actionable failure signals
  // surface elsewhere at their own severity: `task.failed`/`*.failed` (warn),
  // `run.failed` (fail), `dag.spec.needs_attention` (fail). `gate.verdict` is the
  // informational per-run pass/fail roll-up — there is NO dispatcher promotion for
  // any gate event (see effectiveSeverityFor); the terminal `run.*` carries the loud
  // signal. Listed explicitly (rather than left to the `?? "info"` fallback) so the
  // intent is visible and the matrix UI is honest.
  "gate.started": "info",
  "gate.passed": "info",
  "gate.failed": "info",
  "gate.advisory_failed": "info",
  "gate.quarantine_excluded": "info",
  "gate.publish_failed": "info",
  "gate.verdict": "info",

  // Runner / allocator
  "runner.allocated": "info",
  "runner.released": "info",
  // A swept runner is a LEAK the normal release path missed (a crashed run, a
  // past-TTL runner, a wedged allocation) — operator-actionable, so warn.
  "runner.swept": "warn",
  // Security-baseline cleanup-proof: a release normally cleans up (info). The
  // dispatcher promotes to warn when `cleanedUp=false` (residual resources to
  // reconcile) — a leaked runner is operator-actionable.
  "release.finalized": "info",
  "runner.failed": "warn",
  "allocator.requested": "info",
  "allocator.allocated": "info",
  "allocator.failed": "warn",

  // Workspace
  "workspace.prepared": "info",
  "workspace.git_captured": "info",
  "workspace.failed": "warn",
  // apex v35: prep deps-install failed but was deferred to the gate self-heal (not a
  // strand). Warn — loud enough to surface on the timeline, not a terminal failure.
  "workspace.bootstrap_deferred": "warn",

  // Credentials
  "credential.requested": "info",
  "credential.loaded": "info",
  "credential.failed": "warn",

  // Cost
  "cost.resolved": "info",
  "cost.failed": "warn",
  // An unrecognized credential ref priced a real call as $0 — a budget-defeating
  // misconfig the operator must fix; surfaced as fail.
  "cost.unattributed": "fail",
  // A configured dollar ceiling can never fire against this credential — the run
  // fails closed; a setup-time misconfig the operator must fix; fail.
  "cost.ceiling_unreachable": "fail",
  // silent-fallback hardening. A managed OpenRouter per-call real-cost capture
  // failed — authoritative platform spend that would otherwise silently vanish;
  // fail. A run-end reconcile resolved a positive real total that landed on no
  // row — observed real spend lost; fail. A model is unpriced in the notional
  // source — list-value tracking silently drops; operator-actionable drift; warn.
  "cost.provider_capture_failed": "fail",
  "cost.reconcile_failed": "fail",
  "cost.notional_unpriced": "warn",

  // Usage probe reads (silent-fallback hardening). A read FAILED (timeout / SSH /
  // nonzero-exit / malformed) — it erases usage/window-pressure/reconcile, so it
  // is `fail` (NEVER a silent no-data run). A real CLI call missing token telemetry
  // is mandatory-accounting drift the operator must fix; warn.
  "usage.read_failed": "fail",
  "usage.token_accounting_failed": "warn",
  // Codex critic #18: the RUN-END mandatory accounting seam THREW — a hard
  // mandatory-accounting invariant violation the operator MUST see; `fail` so it
  // clears the default-route floor and reaches the org's channels even without a
  // per-event route (the terminal-outcome demotion pairs with the fail-tier event).
  "usage.accounting_failed": "fail",

  // GitHub integration
  "github.branch.pushed": "info",
  "github.pr.created": "ok",
  "github.pr.ready": "ok",
  "github.pr.merged": "ok",
  "github.failed": "warn",

  // Post-merge auto-issue creation (tempering.md dim A): a post-merge regression
  // on default_branch is a real change-failure (fail); auto-opening its tracking
  // issue is an operator-actionable signal (warn).
  "merge.post_merge_failed": "fail",
  "issue.opened": "warn",

  // DAG escalation: a spec parked at the terminal `needs_attention` status — the
  // strand reconciler exhausted its bounded re-enqueue budget, OR the
  // intent-preserving conflict resolver judged the conflict genuinely
  // irreconcilable. This is a RARE, GENUINE "a human must look" signal (the
  // human-escalation-discipline contract), so it is `fail`: it must clear the
  // matrix's warn floor AND the code-level default route so the escalation
  // actually reaches a person rather than silently parking.
  "dag.spec.needs_attention": "fail",

  // Operator cancel-spec/cancel-run: a DELIBERATE human action (the operator chose to
  // cancel), not a failure — `info` so the matrix rows default off but the records stay
  // auditable. Mirrors the operator-initiated recovery lineage above. (The dependents a
  // cancel parks each emit their OWN `dag.spec.needs_attention` at `fail`, so the human
  // decision the cascade-block raises still reaches the operator.)
  "spec.cancelled": "info",
  "run.cancelled": "info",

  // A corrupt persisted project config the walker read while resolving a NON-merge
  // eagerness knob (it proceeded at the safe default, but the corruption is real and
  // operator-fixable) → `warn`: surfaced rather than silently parked at `info`.
  "dag.config.corrupt": "warn",

  // The GENUINE dollar-budget pause: cumulative spend reached the configured
  // ceiling and the DagWalker stopped enqueuing. This is operator-ACTIONABLE — the
  // run halted and the operator must decide (raise the ceiling, or accept the
  // stop) — so it is `warn`: it clears the matrix warn floor AND the code-level
  // default route, reaching the operator rather than silently parking at `info`.
  "dag.budget.paused": "warn",

  // A budget FRACTION milestone (50% / 80% of the ceiling crossed BEFORE the terminal
  // pause): the "approaching your money ceiling" heads-up a human wants DURING an
  // autonomous run. It is a milestone the human ACTS on (decide whether to raise the
  // ceiling before the run pauses), so it is `warn`: it clears the default route and
  // reaches the org's channels WITHOUT per-event route config — the milestone-
  // notifications chain. Emitted once per band per budget window (no re-walk spam).
  "dag.budget.milestone": "warn",

  // A deploy that triggered but could NOT be proven live after the bounded verify
  // retry. Operator-actionable (the product never came up) → `warn` so the failure
  // reaches the operator rather than a silent triggered-but-unverified stall.
  "deploy.failed": "warn",

  // A deploy that was EXPECTED could not even be RESOLVED on merge (incomplete deploy
  // config / a missing mergeSha) — a PRE-resolution skip that previously was console-only.
  // Operator-actionable (the merge produced no deploy) → `warn` so it reaches the operator.
  "deploy.skipped": "warn",

  // deploy.verified ("a live working URL is up"): the single highest-signal SUCCESS
  // milestone of an autonomous run — the product is provably reachable. This is the
  // milestone a human most wants pushed DURING a run, so it routes BY DEFAULT (`warn`,
  // not the routine `info`): it clears the default-route floor and reaches the org's
  // channels without per-event route config — the milestone-notifications chain.
  // (deploy.triggered stays `info`: routine lifecycle, not the proven-live milestone.)
  "deploy.verified": "warn",

  // deploy.pending_manual ("please confirm the deploy"): the OPERATOR is the required
  // next actor — a manual_external deploy is stuck without them. Operator-actionable →
  // `warn` so the wake reaches the operator's default route rather than a silent info
  // lifecycle entry.
  "deploy.pending_manual": "warn",
  // deploy.manual_confirmed: audit-trail lifecycle entry (the operator acted); the
  // downstream verify emits `deploy.verified` (`warn`) as the proven-live milestone.
  "deploy.manual_confirmed": "info",

  // demo.evidence.recorded ("a behavior was exercised on the live surface"): routine
  // per-behavior verdict lifecycle — the summary (demo.completed) carries the pass/fail
  // tally the operator acts on, so keep the per-behavior grain at `info` (no matrix spam).
  "demo.evidence.recorded": "info",
  // demo.completed ("the demo finished"): routine `info` summary when every behavior
  // passed. The dispatcher promotes to `warn` when `failed > 0` (apex's "deploy verified
  // but a planted issue makes behaviors fail" signal) so the fail-tier summary reaches
  // the operator via the default route, even without a per-event route configured.
  "demo.completed": "info",
  // demo.failed ("the demo could NOT record its evidence"): the operator-actionable
  // signal that a verified deploy could not be demoed (grant lost mid-flight, an
  // unsupported surface kind, a provider read failure). Mirrors `deploy.failed` at
  // `warn` so it clears the default-route floor and reaches the operator rather than
  // a subscriber-swallowed `log.error`.
  "demo.failed": "warn",

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

  // recovery lineage — operator-initiated recovery progress; info so
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

  // Per-fragment authoring (F2 — docs/roadmap/templating-system.md). started +
  // succeeded are routine `ok`; a failed authoring run is a LOUD terminal signal
  // (the derive halts) → `fail`, so it clears the matrix warn floor and the
  // code-level default route, reaching the operator. attempt is per-iteration
  // trajectory noise (writer body + rejection + decision) — `info` so the matrix
  // row defaults off, but an operator debugging a stuck writer can opt in.
  "fragment.authoring.started": "ok",
  "fragment.authoring.attempt": "info",
  "fragment.authoring.succeeded": "ok",
  "fragment.authoring.failed": "fail",
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
