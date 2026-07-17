import type { z } from "zod";
import {
  AuditPostureStrandsFindingsPayload,
  AuditorCompletedPayload,
  AuditorFailedPayload,
  AuditorFindingsRoutedPayload,
  AuditorRejectedPayload,
  AuditorStartedPayload,
  AuditorVerdictPayload,
  CheckerCompletedPayload,
  CheckerFailedPayload,
  CheckerRejectedPayload,
  CheckerStartedPayload,
  CheckerVerdictPayload,
  PlannerCompletedPayload,
  PlannerFailedPayload,
  PlannerRerequestedPayload,
  PlannerStartedPayload,
  PlannerSubtasksEmittedPayload,
  WriterCompletedPayload,
  WriterFailedPayload,
  WriterStartedPayload,
  WriterSubtaskCompletedPayload,
  loopEventRegistry,
  templateEventRegistry,
  WriterSubtaskFailedPayload,
  WriterSubtaskProgressPayload,
  WriterSubtaskStartedPayload,
} from "./schemas/answerer.js";
import {
  AllocatorAllocatedPayload,
  AllocatorFailedPayload,
  AllocatorRequestedPayload,
  CostCeilingUnreachablePayload,
  CostCreditRateUnknownPayload,
  CostFailedPayload,
  CostManagedMeteringSkippedPayload,
  CostNotionalUnpricedPayload,
  CostOverageUnobservablePayload,
  CostProviderCaptureFailedPayload,
  CostReconcileFailedPayload,
  CostResolvedPayload,
  CostUnattributedPayload,
  CredentialConfiguredPayload,
  CredentialFailedPayload,
  CredentialGithubConfiguredPayload,
  CredentialLoadedPayload,
  CredentialRequestedPayload,
  CredentialScopedTokenMintedPayload,
  ReleaseFinalizedPayload,
  RunnerAllocatedPayload,
  RunnerFailedPayload,
  RunnerReleasedPayload,
  RunnerSweptPayload,
  UsageAccountingObservedPayload,
  UsageReadFailedPayload,
  UsageTokenAccountingFailedPayload,
  UsageWindowObservedPayload,
  UsageWindowPressurePayload,
  UsageAccountingFailedPayload,
  WorkspaceBootstrapDeferredPayload,
  WorkspaceFailedPayload,
  WorkspaceGitCapturedPayload,
  WorkspacePreparedPayload,
} from "./schemas/infra.js";
import {
  AppEnvRuntimeAttachedPayload,
  DeployTriggeredPayload,
  DeployVerifiedPayload,
  DeployFailedPayload,
  DeploySkippedPayload,
  DeployPendingManualPayload,
  DeployManualConfirmedPayload,
  GithubBranchPushedPayload,
  GithubFailedPayload,
  GithubPrCreatedPayload,
  GithubPrMergedPayload,
  GithubPrNoCommitsPayload,
  GithubPrReadyPayload,
  helloEventRegistry,
  MergeBehindPayload,
  MergeBlockedPayload,
  MergeCompletedPayload,
  MergeConflictPayload,
  MergeConflictEntityMergedPayload,
  MergeConflictIrreconcilablePayload,
  MergeConflictReplanRoutedPayload,
  MergeConflictResolvedPayload,
  MergeConflictResolvingPayload,
  MergeFailedPayload,
  MergeQueuedPayload,
  MergeRebasedPayload,
  MergeRegatePendingPayload,
  MergeRetargetedPayload,
  MergeSpeculativeHeldPayload,
  IntegrationProvisionedPayload,
  wave1EventRegistry,
  governanceVocabularyRegistry,
  designSystemVocabularyRegistry,
  NotificationEnqueuedPayload,
  NotificationFailedPayload,
  NotificationSentPayload,
  ReviewApprovedPayload,
  ReviewAutoApprovedPayload,
  ReviewChangesRequestedPayload,
  ReviewRequestedPayload,
  w0EventRegistry,
  wave4EventRegistry,
  wave5And6AndResolutionClusterEventRegistry,
} from "./schemas/integrations.js";
import {
  MergeBatchBisectingPayload,
  MergeBatchCheckingPayload,
  MergeBatchCulpritPayload,
  MergeBatchGateReworkRoutedPayload,
  MergeBatchInfraBlockedPayload,
  MergeBatchPassedPayload,
  MergeDequeuedPayload,
  MergeQueueAdvancedPayload,
  MergeQueueInfraBlockedPayload,
  MergeReGateGateReworkRoutedPayload,
  MergeScheduledPayload,
} from "./schemas/mergeQueue.js";
import {
  CiFlakyDetectedPayload,
  CiJunitMissingPayload,
  CiTestQuarantinedPayload,
  CiTestsReportedPayload,
} from "./schemas/ciFlaky.js";
import {
  DemoCompletedPayload,
  DemoEvidenceRecordedPayload,
  DemoFailedPayload,
  IssueOpenedPayload,
  MergePostMergeFailedPayload,
} from "./schemas/postMerge.js";
import {
  GateAdvisoryFailedPayload,
  GateFailedPayload,
  GatePassedPayload,
  GatePublishFailedPayload,
  GateQuarantineExcludedPayload,
  GateStartedPayload,
  GateVerdictPayload,
} from "./schemas/gate.js";
import {
  JobLeaseExpiredPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunQueuedPayload,
  RunStartedPayload,
  SpecCancelledPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskQueuedPayload,
  TaskStartedPayload,
  windowPauseEventRegistry,
} from "./schemas/lifecycle.js";
import {
  RecoveryInspectionOpenedPayload,
  RecoveryReplanQueuedPayload,
  RecoveryReviseRoutedPayload,
  RecoveryRollbackQueuedPayload,
} from "./schemas/recovery.js";
import { eventVocabularyMiscRegistry } from "./schemas/eventVocabularyMisc.js";
import {
  DagBudgetMilestonePayload,
  DagBudgetPausedPayload,
  DagConcurrencySaturatedPayload,
  DagConfigCorruptPayload,
  DagDrainedPayload,
  DagSpecAncestorNotReadyPayload,
  DagSpecAttentionResolvedPayload,
  DagSpecEnqueuedPayload,
  DagSpecNeedsAttentionPayload,
  DagSpecPercolatedPayload,
  DagSpecPercolatingPayload,
  DagSpecPercolationDeferredPayload,
  DagSpecPercolationReplanPayload,
  DagSpecRedrivenPayload,
  DagSpecSpeculationHeldPayload,
  DagSpecSpeculativePayload,
  IntegrationProofReusedPayload,
  IntegrationRebasePayload,
} from "./schemas/dag.js";
// Single source of truth mapping event names to typed Zod payload schemas.
export const EventRegistry = {
  ...w0EventRegistry,
  ...wave1EventRegistry,
  ...governanceVocabularyRegistry,
  ...designSystemVocabularyRegistry,
  ...wave4EventRegistry,
  ...wave5And6AndResolutionClusterEventRegistry,
  ...eventVocabularyMiscRegistry,
  // Run lifecycle
  "run.queued": RunQueuedPayload,
  "run.started": RunStartedPayload,
  "run.completed": RunCompletedPayload,
  "run.failed": RunFailedPayload,
  // task #82 — window-pause auto-resume cycle.
  ...windowPauseEventRegistry,
  // Task lifecycle
  "task.queued": TaskQueuedPayload,
  "task.started": TaskStartedPayload,
  "task.completed": TaskCompletedPayload,
  "task.failed": TaskFailedPayload,
  // queue lease recovery: a lapsed-lease job is requeued (unbounded, no attempt-cap dead-letter); LOUD infra signal (lifecycle.ts).
  "job.lease_expired": JobLeaseExpiredPayload,
  // Operator cancel-spec/cancel-run audit (terminal cancel + runner release; schemas/lifecycle.ts).
  "spec.cancelled": SpecCancelledPayload,
  "run.cancelled": RunCancelledPayload,
  // Planner role (single-pass + subtask emission)
  "planner.started": PlannerStartedPayload,
  "planner.completed": PlannerCompletedPayload,
  "planner.failed": PlannerFailedPayload,
  "planner.subtasks.emitted": PlannerSubtasksEmittedPayload,
  "planner.rerequested": PlannerRerequestedPayload,

  // Writer role (single-pass + subtask narration)
  "writer.started": WriterStartedPayload,
  "writer.completed": WriterCompletedPayload,
  "writer.failed": WriterFailedPayload,
  "writer.subtask.started": WriterSubtaskStartedPayload,
  "writer.subtask.completed": WriterSubtaskCompletedPayload,
  "writer.subtask.failed": WriterSubtaskFailedPayload,
  "writer.subtask.progress": WriterSubtaskProgressPayload,

  // Checker role
  "checker.started": CheckerStartedPayload,
  "checker.completed": CheckerCompletedPayload,
  "checker.failed": CheckerFailedPayload,
  "checker.verdict": CheckerVerdictPayload,
  "checker.rejected": CheckerRejectedPayload,

  // Auditor role
  "auditor.started": AuditorStartedPayload,
  "auditor.completed": AuditorCompletedPayload,
  "auditor.failed": AuditorFailedPayload,
  "auditor.verdict": AuditorVerdictPayload,
  "auditor.rejected": AuditorRejectedPayload,
  // S3: posture-gate residual disposition; Loop 3: autonomous-run strand-findings preflight.
  "auditor.findings_routed": AuditorFindingsRoutedPayload,
  "audit.posture_strands_findings": AuditPostureStrandsFindingsPayload,
  // Sub-registries split into their schema modules for the 500-line cap.
  ...loopEventRegistry,
  ...templateEventRegistry,
  // Runner allocation (+ periodic-sweeper reclaim of a STUCK/LEAKED runner)
  "runner.allocated": RunnerAllocatedPayload,
  "runner.released": RunnerReleasedPayload,
  "runner.swept": RunnerSweptPayload,
  // Security-baseline cleanup-proof: the run-end release audit (torn down + residuals).
  "release.finalized": ReleaseFinalizedPayload,
  "runner.failed": RunnerFailedPayload,
  "allocator.requested": AllocatorRequestedPayload,
  "allocator.allocated": AllocatorAllocatedPayload,
  "allocator.failed": AllocatorFailedPayload,
  // Workspace
  "workspace.prepared": WorkspacePreparedPayload,
  "workspace.git_captured": WorkspaceGitCapturedPayload,
  "workspace.failed": WorkspaceFailedPayload,
  "workspace.bootstrap_deferred": WorkspaceBootstrapDeferredPayload,
  // Credentials
  "credential.requested": CredentialRequestedPayload,
  "credential.loaded": CredentialLoadedPayload,
  "credential.failed": CredentialFailedPayload,
  "credential.configured": CredentialConfiguredPayload,
  "credential.github.configured": CredentialGithubConfiguredPayload,
  // Managed-hosting dimension D: a per-run scoped Vault child token was minted (ref paths + TTL/uses; never the token value).
  "credential.scoped_token_minted": CredentialScopedTokenMintedPayload,
  // Cost resolution
  "cost.resolved": CostResolvedPayload,
  "cost.failed": CostFailedPayload,
  "cost.unattributed": CostUnattributedPayload,
  "cost.ceiling_unreachable": CostCeilingUnreachablePayload,
  // cost PR-C: credit-rate-unknown + overage-unobservable + BYOK managed-metering-skipped (NULL real spend, loud).
  "cost.credit_rate_unknown": CostCreditRateUnknownPayload,
  "cost.overage_unobservable": CostOverageUnobservablePayload,
  "cost.managed_metering_skipped": CostManagedMeteringSkippedPayload,
  // silent-fallback hardening (loud discriminated cost failures).
  "cost.provider_capture_failed": CostProviderCaptureFailedPayload,
  "cost.notional_unpriced": CostNotionalUnpricedPayload,
  "cost.reconcile_failed": CostReconcileFailedPayload,

  // Usage monitoring: codexbar windows + ccusage accounting, runner-side over SSH.
  "usage.window.observed": UsageWindowObservedPayload,
  "usage.window.pressure": UsageWindowPressurePayload,
  "usage.accounting.observed": UsageAccountingObservedPayload,
  // silent-fallback hardening: loud usage READ failure, per-CLI token telemetry drift, and RUN-END mandatory-accounting seam throw (Codex critic #18 — outcome-demoting).
  "usage.read_failed": UsageReadFailedPayload,
  "usage.token_accounting_failed": UsageTokenAccountingFailedPayload,
  "usage.accounting_failed": UsageAccountingFailedPayload,

  // GitHub integration
  "github.branch.pushed": GithubBranchPushedPayload,
  "github.pr.created": GithubPrCreatedPayload,
  "github.pr.ready": GithubPrReadyPayload,
  "github.pr.merged": GithubPrMergedPayload,
  "github.pr.no_commits": GithubPrNoCommitsPayload,
  "github.failed": GithubFailedPayload,

  // Flaky-test detection + auto-quarantine: the detector flags a STEP that toggled outcome on UNCHANGED code + quarantines it.
  "ci.flaky.detected": CiFlakyDetectedPayload,
  "ci.test.quarantined": CiTestQuarantinedPayload,
  // CI-intelligence per-test grain: the native gate ingested the runner's JUnit report (summary).
  "ci.tests.reported": CiTestsReportedPayload,
  // A gate tier DECLARED a `junitReport` but produced none — DURABLE + advisory no-silent-skip signal.
  "ci.junit_missing": CiJunitMissingPayload,
  // The in-loop deterministic native gate (exit-code driven); `gate.verdict` is the terminal roll-up.
  "gate.started": GateStartedPayload,
  "gate.passed": GatePassedPayload,
  "gate.failed": GateFailedPayload,
  "gate.advisory_failed": GateAdvisoryFailedPayload,
  "gate.quarantine_excluded": GateQuarantineExcludedPayload,
  "gate.publish_failed": GatePublishFailedPayload,
  "gate.verdict": GateVerdictPayload,
  // Review lifecycle
  "review.requested": ReviewRequestedPayload,
  "review.approved": ReviewApprovedPayload,
  "review.auto_approved": ReviewAutoApprovedPayload,
  "review.changes_requested": ReviewChangesRequestedPayload,
  // merge stage: per-repo integration dispatch + conflict scaffolding
  "merge.scheduled": MergeScheduledPayload,
  "merge.queued": MergeQueuedPayload,
  "merge.completed": MergeCompletedPayload,
  "merge.failed": MergeFailedPayload,
  "merge.conflict": MergeConflictPayload,
  // up-to-date enforcement: branch behind base → auto-rebase + re-gate CI (re_gate_pending = not yet terminal).
  "merge.behind": MergeBehindPayload,
  "merge.rebased": MergeRebasedPayload,
  "merge.regate_pending": MergeRegatePendingPayload,
  // intent-preserving conflict resolution: resolver invoked → resolved (re-gated) or irreconcilable (one spec re-planned, intent kept alive); §3.2 entity_merged = the deterministic different-entity-same-file splice (agent SKIPPED).
  "merge.conflict.resolving": MergeConflictResolvingPayload,
  "merge.conflict.resolved": MergeConflictResolvedPayload,
  "merge.conflict.entity_merged": MergeConflictEntityMergedPayload,
  "merge.conflict.irreconcilable": MergeConflictIrreconcilablePayload,
  "merge.conflict.replan_routed": MergeConflictReplanRoutedPayload,
  // external-push governance posture block (strict / audit_only)
  "merge.blocked": MergeBlockedPayload,
  // §2c: a speculative dependent's MERGE held until its ancestors merge, then re-targeted to default_branch.
  "merge.speculative_held": MergeSpeculativeHeldPayload,
  "merge.retargeted": MergeRetargetedPayload,
  // §2d: the native intelligent merge queue. A ready run ENTERS (merge.queued w/ native_queue), the
  // coordinator selects the DAG-ordered head (merge.queue.advanced), a leaver records merge.dequeued.
  "merge.queue.advanced": MergeQueueAdvancedPayload,
  "merge.dequeued": MergeDequeuedPayload,
  // GitHub-5xx resilience (GAP #2d): a transient infra error blocked the per-PR merge DRIVE and
  // the hold can no longer recover (re-drive ceiling exhausted / state unconfirmable) — LOUD halt.
  "merge.queue.infra_blocked": MergeQueueInfraBlockedPayload,
  // §2d: speculative batch-check + bisect. Integrate `default_branch + batch PRs` + CI-check
  // (checking); a green check merges in DAG order (passed); a failed check is BISECTED to the
  // offending PR (bisecting → culprit). No failed batch reaches main.
  "merge.batch.checking": MergeBatchCheckingPayload,
  "merge.batch.passed": MergeBatchPassedPayload,
  "merge.batch.bisecting": MergeBatchBisectingPayload,
  "merge.batch.culprit": MergeBatchCulpritPayload,
  // A GATE/CI failure (not a conflict) bisected to ONE culprit → WRITER REWORK (steering = gate output).
  "merge.batch.gate_rework_routed": MergeBatchGateReworkRoutedPayload,
  // A pre-merge / base-shift re-gate FAILED a GATE TIER on a CLEANLY-rebased tree (no conflict) → WRITER REWORK (not irreconcilable escalate); convergence detector owns escalation.
  "merge.regate.gate_rework_routed": MergeReGateGateReworkRoutedPayload,
  // A transient/transport INFRA error blocked the batch check: bounded-retry then HOLD loud; no PR blamed.
  "merge.batch.infra_blocked": MergeBatchInfraBlockedPayload,
  // Post-merge auto-issue creation (tempering.md dim A): after a run's PR
  // merges, a base-branch CI FAILURE auto-opens ONE tracking issue (the per-
  // merge idempotency marker — never spammed on repeated checks).
  "merge.post_merge_failed": MergePostMergeFailedPayload,
  "issue.opened": IssueOpenedPayload,

  // Notification dispatch (schemas declared; dispatcher lands in)
  "notification.enqueued": NotificationEnqueuedPayload,
  "notification.sent": NotificationSentPayload,
  "notification.failed": NotificationFailedPayload,

  // capability-driven onboarding: a project leaf resource was provisioned
  // or bound from the org grant (refs only, never secret values).
  "integration.provisioned": IntegrationProvisionedPayload,

  // Deploy lifecycle (deploy-on-merge): triggered → verified (poll-to-READY + URL smoke) / failed
  // (bounded-retry exhausted; LOUD terminal) / skipped (pre-resolution failure — recorded durably);
  // pending_manual/manual_confirmed = the manual_external attestation lifecycle (operator wake + route flip).
  "deploy.triggered": DeployTriggeredPayload,
  "deploy.verified": DeployVerifiedPayload,
  "deploy.failed": DeployFailedPayload,
  "deploy.skipped": DeploySkippedPayload,
  "deploy.pending_manual": DeployPendingManualPayload,
  "deploy.manual_confirmed": DeployManualConfirmedPayload,

  // Demos-as-evidence (design doc § "Native Deployment And Demos"): a verified
  // deploy exercises each spec BEHAVIOR + records evidence per behavior
  // (demo.evidence.recorded) + a summary tally (demo.completed) / a durable
  // failure event when the demo could not complete (mirrors deploy.failed —
  // fixed reason category + non-secret detail — so the operator SEES the demo
  // failure on the timeline instead of a subscriber-swallowed log line).
  "demo.evidence.recorded": DemoEvidenceRecordedPayload,
  "demo.completed": DemoCompletedPayload,
  "demo.failed": DemoFailedPayload,

  // Hello / smoke run
  ...helloEventRegistry,

  // Redaction audit: emitted whenever an elevated-scope actor
  // reads raw payload values via the redaction serializer.

  // failure recovery: operator-initiated recovery actions against a
  // halted run, persisted as run lineage in the events table.
  "recovery.revise_routed": RecoveryReviseRoutedPayload,
  "recovery.replan_queued": RecoveryReplanQueuedPayload,
  "recovery.rollback_queued": RecoveryRollbackQueuedPayload,
  "recovery.inspection_opened": RecoveryInspectionOpenedPayload,

  // Tanren-method benchmark: the post-merge HIDDEN-ACCEPT-TIER outcome (§2.1).
  // Emitted by the BenchmarkRunner's accept step after a trial's PR merges —
  // the equivalence oracle the config under test never saw.

  // DagWalker (autonomy-engine.md §1a): the per-project background scheduler's
  // autonomous decisions — auto-enqueue, drain, budget pause/milestone, saturation.
  "dag.spec.enqueued": DagSpecEnqueuedPayload,
  "dag.drained": DagDrainedPayload,
  // The GENUINE dollar-budget pause (spend reached the ceiling) — distinct from the
  // concurrency-saturation hold (no in-flight slot free) below.
  "dag.budget.paused": DagBudgetPausedPayload,
  // The 50% / 80% budget-fraction "approaching your ceiling" heads-up (routes by default).
  "dag.budget.milestone": DagBudgetMilestonePayload,
  "dag.concurrency.saturated": DagConcurrencySaturatedPayload,
  // no_silent_fallbacks (LOUD-DEFAULT): a corrupt project config surfaced — not swallowed.
  "dag.config.corrupt": DagConfigCorruptPayload,
  // §2c: speculative execution — a dependent started early on a speculative branch, or held over the depth cap.
  "dag.spec.speculative": DagSpecSpeculativePayload,
  "dag.spec.speculation_held": DagSpecSpeculationHeldPayload,
  // §3 NEVER-DISCARD: a dependent benign-WAITS (→ open) for a non-terminal ancestor that has not published its head.
  "dag.spec.ancestor_not_ready": DagSpecAncestorNotReadyPayload,
  // apex v35: a random/transient run failure RE-DRIVES the spec (→ open), never a terminal strand.
  "dag.spec.redriven": DagSpecRedrivenPayload,
  // §2c CHANGE-PERCOLATION: an ancestor changed after a dependent started speculatively — the delta percolates the chain (NOT discarded).
  "dag.spec.percolating": DagSpecPercolatingPayload,
  "dag.spec.percolated": DagSpecPercolatedPayload,
  "dag.spec.percolation_deferred": DagSpecPercolationDeferredPayload,
  "dag.spec.percolation_replan": DagSpecPercolationReplanPayload,
  // §3/§7 NEVER-DISCARD REBASE: the BaseShiftCoordinator rebased the dependent's EXISTING branch in
  // place (same run row). Records the categorical `decision` + kept `runId`; the `rebase_vs_rebuild`
  // read-side joins cost at read time.
  "integration.rebase": IntegrationRebasePayload,
  // §3 PROOF REUSE: the gate/CI verdict site found a recorded PASSING proof whose six-component
  // `proofReuseKey` matched the live inputs EXACTLY, so it SKIPPED the re-gate and reused the verdict
  // — emitted ONLY on an exact match against a passing proof (any drift / non-pass / unknown recomputes).
  "integration.proof.reused": IntegrationProofReusedPayload,
  // A spec parked at the terminal needs_attention status (the DAG frees its slot +
  // blocks only its dependents, asking a human loudly). Reached by the native merge
  // queue's conflict resolver when two intents are genuinely irreconcilable.
  "dag.spec.needs_attention": DagSpecNeedsAttentionPayload,
  // The human-in-the-loop resolution of a needs_attention escalation: the operator
  // addressed the blocker and re-queued the spec (needs_attention → open), resetting
  // its bounded re-enqueue budget so the DagWalker genuinely re-runs it.
  "dag.spec.attention_resolved": DagSpecAttentionResolvedPayload,

  // Plane B app environment: the project's runtime-scoped app env was attached to the DEPLOYED
  // app (Vercel/Fly). Records the deploy target + env KEY NAMES only — never a secret value.
  "app_env.runtime_attached": AppEnvRuntimeAttachedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;

export type EventRegistry = typeof EventRegistry;
export type EventName = keyof EventRegistry;
export type EventPayload<N extends EventName> = z.infer<EventRegistry[N]>;

const eventNames = new Set<EventName>(Object.keys(EventRegistry) as EventName[]);

export function isEventName(value: string): value is EventName {
  return eventNames.has(value as EventName);
}

export function assertEventName(value: string): asserts value is EventName {
  if (!isEventName(value)) throw new Error(`undeclared event name: ${value}`);
}

export function listEventNames(): EventName[] {
  return [...eventNames].sort();
}

export class UnknownEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`unknown event type: ${eventType}`);
  }
}
export interface TypedEvent<N extends EventName = EventName> {
  eventType: N;
  payload: EventPayload<N>;
}
export interface RawEventRow {
  event_type: string;
  payload: unknown;
}

// decodeEvent parses a DB row payload through the registered Zod schema (defense-in-depth for replay/import; write-time producers are already validated).
export function decodeEvent(row: RawEventRow): TypedEvent {
  if (!isEventName(row.event_type)) {
    throw new UnknownEventTypeError(row.event_type);
  }
  const payload = EventRegistry[row.event_type].parse(row.payload);
  return { eventType: row.event_type, payload } as TypedEvent;
}
