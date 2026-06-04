import type { z } from "zod";
import {
  AuditorCompletedPayload,
  AuditorFailedPayload,
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
  WriterSubtaskFailedPayload,
  WriterSubtaskStartedPayload,
} from "./schemas/answerer.js";
import {
  AllocatorAllocatedPayload,
  AllocatorFailedPayload,
  AllocatorRequestedPayload,
  CostCeilingUnreachablePayload,
  CostFailedPayload,
  CostResolvedPayload,
  CostUnattributablePayload,
  CostUnattributedPayload,
  CredentialFailedPayload,
  CredentialLoadedPayload,
  CredentialRequestedPayload,
  CredentialScopedTokenMintedPayload,
  RunnerAllocatedPayload,
  RunnerFailedPayload,
  RunnerReleasedPayload,
  UsageAccountingObservedPayload,
  UsageWindowObservedPayload,
  UsageWindowPressurePayload,
  WorkspaceFailedPayload,
  WorkspaceGitCapturedPayload,
  WorkspacePreparedPayload,
} from "./schemas/infra.js";
import {
  AppEnvCiPropagatedPayload,
  AppEnvRuntimeAttachedPayload,
  CiFailedPayload,
  CiPassedPayload,
  CiStartedPayload,
  GithubBranchPushedPayload,
  GithubFailedPayload,
  GithubPrCreatedPayload,
  GithubPrMergedPayload,
  GithubPrReadyPayload,
  HelloCompletedPayload,
  HelloSshCompletedPayload,
  HelloSshStartedPayload,
  HelloStartedPayload,
  MergeBehindPayload,
  MergeBlockedPayload,
  MergeCompletedPayload,
  MergeConflictPayload,
  MergeConflictIrreconcilablePayload,
  MergeConflictReplanRoutedPayload,
  MergeConflictResolvedPayload,
  MergeConflictResolvingPayload,
  MergeFailedPayload,
  MergeIntegrationCleanedPayload,
  MergeQueuedPayload,
  MergeRebasedPayload,
  MergeRetargetedPayload,
  MergeSpeculativeHeldPayload,
  IntegrationProvisionedPayload,
  NotificationEnqueuedPayload,
  NotificationFailedPayload,
  NotificationSentPayload,
  Phase1FixtureCiPendingPayload,
  Phase1FixtureCompletedPayload,
  Phase1FixtureFailedPayload,
  Phase1FixtureStartedPayload,
  ReviewApprovedPayload,
  ReviewAutoApprovedPayload,
  ReviewChangesRequestedPayload,
  ReviewRequestedPayload,
} from "./schemas/integrations.js";
import {
  MergeBatchBisectingPayload,
  MergeBatchCheckingPayload,
  MergeBatchCulpritPayload,
  MergeBatchInfraBlockedPayload,
  MergeBatchPassedPayload,
  MergeDequeuedPayload,
  MergeQueueAdvancedPayload,
  MergeQueueInfraBlockedPayload,
} from "./schemas/mergeQueue.js";
import { CiFlakyDetectedPayload, CiTestQuarantinedPayload, CiTestsReportedPayload } from "./schemas/ciFlaky.js";
import { IssueOpenedPayload, MergePostMergeFailedPayload } from "./schemas/postMerge.js";
import { GateAdvisoryFailedPayload, GateFailedPayload, GatePassedPayload, GateStartedPayload } from "./schemas/gate.js";
import {
  JobDeadLetteredPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunQueuedPayload,
  RunStartedPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskQueuedPayload,
  TaskStartedPayload,
} from "./schemas/lifecycle.js";
import {
  RecoveryInspectionOpenedPayload,
  RecoveryReplanQueuedPayload,
  RecoveryReviseRoutedPayload,
  RecoveryRollbackQueuedPayload,
} from "./schemas/recovery.js";
import { RedactionRawAccessPayload } from "./schemas/redaction.js";
import { BenchmarkAcceptFailedPayload, BenchmarkAcceptPassedPayload } from "./schemas/benchmark.js";
import {
  DagBudgetPausedPayload,
  DagConcurrencySaturatedPayload,
  DagDrainedPayload,
  DagSpecEnqueuedPayload,
  DagSpecNeedsAttentionPayload,
  DagSpecPercolatedPayload,
  DagSpecPercolatingPayload,
  DagSpecPercolationDeferredPayload,
  DagSpecPercolationReplanPayload,
  DagSpecSpeculationHeldPayload,
  DagSpecSpeculativePayload,
  DagSpecUnstrandedPayload,
} from "./schemas/dag.js";

// The EventRegistry is the single source of truth mapping event names to
// their typed Zod payload schemas. Adding a new event name requires:
// 1) defining the Zod schema in services/orchestrator/src/engine/events/schemas/
// 2) wiring it into this registry
// 3) registering Sensitivity tags for every payload field in sensitivityRules.ts
// 4) regenerating db migrations for the events.event_type CHECK constraint
//    via scripts/generate-event-type-check.mjs
export const EventRegistry = {
  // Run lifecycle
  "run.queued": RunQueuedPayload,
  "run.started": RunStartedPayload,
  "run.completed": RunCompletedPayload,
  "run.failed": RunFailedPayload,

  // Task lifecycle
  "task.queued": TaskQueuedPayload,
  "task.started": TaskStartedPayload,
  "task.completed": TaskCompletedPayload,
  "task.failed": TaskFailedPayload,

  // P3-0028 queue hardening: a job whose retry budget is exhausted is
  // dead-lettered (terminal) rather than retried forever.
  "job.dead_lettered": JobDeadLetteredPayload,

  // Planner role (legacy single-pass + Phase 2 subtask emission)
  "planner.started": PlannerStartedPayload,
  "planner.completed": PlannerCompletedPayload,
  "planner.failed": PlannerFailedPayload,
  "planner.subtasks.emitted": PlannerSubtasksEmittedPayload,
  "planner.rerequested": PlannerRerequestedPayload,

  // Writer role (legacy + Phase 2 subtask narration)
  "writer.started": WriterStartedPayload,
  "writer.completed": WriterCompletedPayload,
  "writer.failed": WriterFailedPayload,
  "writer.subtask.started": WriterSubtaskStartedPayload,
  "writer.subtask.completed": WriterSubtaskCompletedPayload,
  "writer.subtask.failed": WriterSubtaskFailedPayload,

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

  // Runner allocation
  "runner.allocated": RunnerAllocatedPayload,
  "runner.released": RunnerReleasedPayload,
  "runner.failed": RunnerFailedPayload,
  "allocator.requested": AllocatorRequestedPayload,
  "allocator.allocated": AllocatorAllocatedPayload,
  "allocator.failed": AllocatorFailedPayload,

  // Workspace
  "workspace.prepared": WorkspacePreparedPayload,
  "workspace.git_captured": WorkspaceGitCapturedPayload,
  "workspace.failed": WorkspaceFailedPayload,

  // Credentials
  "credential.requested": CredentialRequestedPayload,
  "credential.loaded": CredentialLoadedPayload,
  "credential.failed": CredentialFailedPayload,
  // Managed-hosting dimension D: a per-run scoped Vault child token was minted
  // (ref paths + TTL/uses; never the token value).
  "credential.scoped_token_minted": CredentialScopedTokenMintedPayload,

  // Cost resolution
  "cost.resolved": CostResolvedPayload,
  "cost.failed": CostFailedPayload,
  "cost.unattributable": CostUnattributablePayload,
  "cost.unattributed": CostUnattributedPayload,
  "cost.ceiling_unreachable": CostCeilingUnreachablePayload,

  // Usage monitoring (P2A-cost-monitors): codexbar live subscription windows
  // + ccusage token-consumption accounting, captured runner-side over SSH.
  "usage.window.observed": UsageWindowObservedPayload,
  "usage.window.pressure": UsageWindowPressurePayload,
  "usage.accounting.observed": UsageAccountingObservedPayload,

  // GitHub integration
  "github.branch.pushed": GithubBranchPushedPayload,
  "github.pr.created": GithubPrCreatedPayload,
  "github.pr.ready": GithubPrReadyPayload,
  "github.pr.merged": GithubPrMergedPayload,
  "github.failed": GithubFailedPayload,

  // CI polling
  "ci.started": CiStartedPayload,
  "ci.passed": CiPassedPayload,
  "ci.failed": CiFailedPayload,

  // P2e-1 (§2d Mergify parity): flaky-test detection + auto-quarantine. The
  // detector reduces ci.passed/ci.failed observations and flags a check that
  // toggled outcome on UNCHANGED code (ci.flaky.detected); that check is then
  // recorded on the quarantine surface (ci.test.quarantined). A
  // consistently-failing check is never flagged — quarantine ≠ ignore-failures.
  "ci.flaky.detected": CiFlakyDetectedPayload,
  "ci.test.quarantined": CiTestQuarantinedPayload,

  // CI-intelligence ingestion (foundation): a JUnit report was uploaded from the
  // generated repo's CI and parsed into per-test rows (ci_test_results). Summary
  // counts + head SHA + attempt only — names/files are public, never secret values.
  "ci.tests.reported": CiTestsReportedPayload,

  // P3-0005 in-loop deterministic gate-check stage (exit-code driven; no agent)
  "gate.started": GateStartedPayload,
  "gate.passed": GatePassedPayload,
  "gate.failed": GateFailedPayload,
  "gate.advisory_failed": GateAdvisoryFailedPayload,

  // Phase 1 fixture orchestration
  "phase1.fixture.started": Phase1FixtureStartedPayload,
  "phase1.fixture.ci_pending": Phase1FixtureCiPendingPayload,
  "phase1.fixture.completed": Phase1FixtureCompletedPayload,
  "phase1.fixture.failed": Phase1FixtureFailedPayload,

  // Review lifecycle (schemas from Phase 2; P3-0008 wires the emitters)
  "review.requested": ReviewRequestedPayload,
  "review.approved": ReviewApprovedPayload,
  "review.auto_approved": ReviewAutoApprovedPayload,
  "review.changes_requested": ReviewChangesRequestedPayload,

  // P3-0008 merge stage: per-repo integration dispatch + conflict scaffolding
  "merge.queued": MergeQueuedPayload,
  "merge.completed": MergeCompletedPayload,
  "merge.failed": MergeFailedPayload,
  "merge.conflict": MergeConflictPayload,
  // P2a up-to-date enforcement: branch behind base → auto-rebase + re-gate CI.
  "merge.behind": MergeBehindPayload,
  "merge.rebased": MergeRebasedPayload,
  // P2b intent-preserving conflict resolution: resolver invoked → resolved
  // (re-gated) or irreconcilable (one spec re-planned, intent kept alive).
  "merge.conflict.resolving": MergeConflictResolvingPayload,
  "merge.conflict.resolved": MergeConflictResolvedPayload,
  "merge.conflict.irreconcilable": MergeConflictIrreconcilablePayload,
  "merge.conflict.replan_routed": MergeConflictReplanRoutedPayload,
  // P3-0023 external-push governance posture block (strict / audit_only)
  "merge.blocked": MergeBlockedPayload,
  // P2c-1 (§2c): a speculative dependent's MERGE held until its ancestors merge,
  // then re-targeted from the integration ref to default_branch + the ref cleaned.
  "merge.speculative_held": MergeSpeculativeHeldPayload,
  "merge.retargeted": MergeRetargetedPayload,
  "merge.integration_cleaned": MergeIntegrationCleanedPayload,
  // P2d (§2d): the native intelligent merge queue. A ready run ENTERS the queue
  // (merge.queued w/ native_queue), the coordinator selects the DAG-ordered head
  // (merge.queue.advanced), and an entry that left without merging (conflict /
  // blocked / failed) records merge.dequeued. Serialized: one merge at a time.
  "merge.queue.advanced": MergeQueueAdvancedPayload,
  "merge.dequeued": MergeDequeuedPayload,
  // GitHub-5xx resilience (GAP #2d): a transient infra error blocked the per-PR merge
  // DRIVE and the hold can no longer recover on its own — the entry exhausted its
  // re-drive ceiling, or the merge state is unconfirmable (auto-retry could double-
  // merge). A LOUD operator-visible halt (does NOT silently re-drive forever).
  "merge.queue.infra_blocked": MergeQueueInfraBlockedPayload,
  // P2d-2 (§2d): speculative batch-check + bisect. The coordinator speculatively
  // integrates `default_branch + batch PRs` + CI-checks that prospective merged state
  // (merge.batch.checking); a green check merges the batch in DAG order
  // (merge.batch.passed); a failed check is BISECTED (merge.batch.bisecting) to isolate
  // the single offending PR (merge.batch.culprit), which is dequeued to a recoverable
  // re-execution while the innocent remainder merges. No failed batch ever reaches main.
  "merge.batch.checking": MergeBatchCheckingPayload,
  "merge.batch.passed": MergeBatchPassedPayload,
  "merge.batch.bisecting": MergeBatchBisectingPayload,
  "merge.batch.culprit": MergeBatchCulpritPayload,
  // A transient/transport INFRA error blocked the batch check (it could not be run) —
  // the coordinator bounded-retried then HOLDS loudly; NO PR is bisected/dequeued.
  "merge.batch.infra_blocked": MergeBatchInfraBlockedPayload,

  // Post-merge auto-issue creation (tempering.md dim A): after a run's PR merges
  // onto default_branch, the watcher reads the post-merge CI on the base branch;
  // a FAILURE records merge.post_merge_failed + auto-opens ONE tracking issue
  // (issue.opened, which is also the per-merge idempotency marker — at most one
  // issue per merge, never spammed on repeated checks).
  "merge.post_merge_failed": MergePostMergeFailedPayload,
  "issue.opened": IssueOpenedPayload,

  // Notification dispatch (schemas declared; dispatcher lands in P2A-0017)
  "notification.enqueued": NotificationEnqueuedPayload,
  "notification.sent": NotificationSentPayload,
  "notification.failed": NotificationFailedPayload,

  // P-INT-2 capability-driven onboarding: a project leaf resource was provisioned
  // or bound from the org grant (refs only, never secret values).
  "integration.provisioned": IntegrationProvisionedPayload,

  // Hello / smoke run
  "hello.started": HelloStartedPayload,
  "hello.ssh_started": HelloSshStartedPayload,
  "hello.ssh_completed": HelloSshCompletedPayload,
  "hello.completed": HelloCompletedPayload,

  // Redaction audit (P2A-0009): emitted whenever an elevated-scope actor
  // reads raw payload values via the redaction serializer.
  "redaction.raw_access": RedactionRawAccessPayload,

  // P2B-0008 failure recovery: operator-initiated recovery actions against a
  // halted run, persisted as run lineage in the events table.
  "recovery.revise_routed": RecoveryReviseRoutedPayload,
  "recovery.replan_queued": RecoveryReplanQueuedPayload,
  "recovery.rollback_queued": RecoveryRollbackQueuedPayload,
  "recovery.inspection_opened": RecoveryInspectionOpenedPayload,

  // Tanren-method benchmark: the post-merge HIDDEN-ACCEPT-TIER outcome (§2.1).
  // Emitted by the BenchmarkRunner's accept step after a trial's PR merges —
  // the equivalence oracle the config under test never saw.
  "benchmark.accept.passed": BenchmarkAcceptPassedPayload,
  "benchmark.accept.failed": BenchmarkAcceptFailedPayload,

  // DagWalker (autonomy-engine.md §1a): the per-project background scheduler's
  // autonomous decisions — a spec auto-enqueued, the DAG drained, or a pause for
  // lack of governed concurrency headroom. Milestones are labels, not gates, so
  // there is no milestone-boundary event.
  "dag.spec.enqueued": DagSpecEnqueuedPayload,
  "dag.drained": DagDrainedPayload,
  // The GENUINE dollar-budget pause (cumulative spend reached the ceiling) vs. the
  // concurrency-saturation hold (no in-flight slot free) — two distinct outcomes.
  "dag.budget.paused": DagBudgetPausedPayload,
  "dag.concurrency.saturated": DagConcurrencySaturatedPayload,
  // P2c-1 (§2c): speculative execution — a dependent started early on a
  // speculative integration branch, or was held over the depth cap.
  "dag.spec.speculative": DagSpecSpeculativePayload,
  "dag.spec.speculation_held": DagSpecSpeculationHeldPayload,
  // P2c-2 (§2c CHANGE-PERCOLATION): an ancestor changed after a dependent started
  // speculatively — the delta percolates down the chain (NOT discarded). Started,
  // absorbed, deferred (lazy P2/P3), or routed-back-to-planner (irreconcilable).
  "dag.spec.percolating": DagSpecPercolatingPayload,
  "dag.spec.percolated": DagSpecPercolatedPayload,
  "dag.spec.percolation_deferred": DagSpecPercolationDeferredPayload,
  "dag.spec.percolation_replan": DagSpecPercolationReplanPayload,
  // NEVER-STRAND reconciler (the DAG self-heal safety net): a spec stuck OCCUPYING
  // A SLOT with no live run was re-enqueued (dag.spec.unstranded), or — once it
  // exceeded the bounded re-enqueue cap — escalated to the terminal needs_attention
  // status (dag.spec.needs_attention), so the DAG either advances or asks loudly.
  "dag.spec.unstranded": DagSpecUnstrandedPayload,
  "dag.spec.needs_attention": DagSpecNeedsAttentionPayload,

  // Plane B app environment (P-APP-ENV-2): the project's runtime-scoped app env was
  // attached to the DEPLOYED app (Vercel/Fly). Records the deploy target + the env
  // KEY NAMES only — never a secret value.
  "app_env.runtime_attached": AppEnvRuntimeAttachedPayload,

  // Plane B app environment (P-APP-ENV-1): the project's test-scoped app env was
  // propagated to the target repo's GitHub Actions secrets (so `tanren-ci.yml`
  // tests that read e.g. RESEND_API_KEY pass). Records the repo + the secret KEY
  // NAMES only — never a secret value.
  "app_env.ci_propagated": AppEnvCiPropagatedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;

export type EventRegistry = typeof EventRegistry;
export type EventName = keyof EventRegistry;
export type EventPayload<N extends EventName> = z.infer<EventRegistry[N]>;

const eventNames = new Set<EventName>(Object.keys(EventRegistry) as EventName[]);

export function isEventName(value: string): value is EventName {
  return eventNames.has(value as EventName);
}

export function assertEventName(value: string): asserts value is EventName {
  if (!isEventName(value)) {
    throw new Error(`undeclared event name: ${value}`);
  }
}

export function listEventNames(): EventName[] {
  return [...eventNames].sort() as EventName[];
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

// decodeEvent parses a database row's payload through the registered Zod
// schema. Producers writing through PgEventStore are already validated at
// write time, so this is a defense-in-depth pass for replay/import flows.
export function decodeEvent(row: RawEventRow): TypedEvent {
  if (!isEventName(row.event_type)) {
    throw new UnknownEventTypeError(row.event_type);
  }
  const schema = EventRegistry[row.event_type];
  const payload = schema.parse(row.payload);
  return { eventType: row.event_type, payload } as TypedEvent;
}
