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
  CostFailedPayload,
  CostResolvedPayload,
  CostUnattributablePayload,
  CredentialFailedPayload,
  CredentialLoadedPayload,
  CredentialRequestedPayload,
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
import { MergeDequeuedPayload, MergeQueueAdvancedPayload } from "./schemas/mergeQueue.js";
import { GateFailedPayload, GatePassedPayload, GateStartedPayload } from "./schemas/gate.js";
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
  DagDrainedPayload,
  DagSpecEnqueuedPayload,
  DagSpecPercolatedPayload,
  DagSpecPercolatingPayload,
  DagSpecPercolationDeferredPayload,
  DagSpecPercolationReplanPayload,
  DagSpecSpeculationHeldPayload,
  DagSpecSpeculativePayload,
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

  // Cost resolution
  "cost.resolved": CostResolvedPayload,
  "cost.failed": CostFailedPayload,
  "cost.unattributable": CostUnattributablePayload,

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

  // P3-0005 in-loop deterministic gate-check stage (exit-code driven; no agent)
  "gate.started": GateStartedPayload,
  "gate.passed": GatePassedPayload,
  "gate.failed": GateFailedPayload,

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

  // Notification dispatch (schemas declared; dispatcher lands in P2A-0017)
  "notification.enqueued": NotificationEnqueuedPayload,
  "notification.sent": NotificationSentPayload,
  "notification.failed": NotificationFailedPayload,

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
  "dag.budget.paused": DagBudgetPausedPayload,
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
