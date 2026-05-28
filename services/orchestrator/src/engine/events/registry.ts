import type { z } from "zod";
import {
  AuditorCompletedPayload,
  AuditorFailedPayload,
  AuditorStartedPayload,
  AuditorVerdictPayload,
  CheckerCompletedPayload,
  CheckerFailedPayload,
  CheckerStartedPayload,
  CheckerVerdictPayload,
  PlannerCompletedPayload,
  PlannerFailedPayload,
  PlannerStartedPayload,
  PlannerSubtasksEmittedPayload,
  WriterCompletedPayload,
  WriterFailedPayload,
  WriterStartedPayload,
  WriterSubtaskCompletedPayload,
  WriterSubtaskFailedPayload,
  WriterSubtaskStartedPayload
} from "./schemas/answerer.js";
import {
  AllocatorAllocatedPayload,
  AllocatorFailedPayload,
  AllocatorRequestedPayload,
  CostFailedPayload,
  CostResolvedPayload,
  CredentialFailedPayload,
  CredentialLoadedPayload,
  CredentialRequestedPayload,
  RunnerAllocatedPayload,
  RunnerFailedPayload,
  RunnerReleasedPayload,
  WorkspaceFailedPayload,
  WorkspaceGitCapturedPayload,
  WorkspacePreparedPayload
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
  NotificationEnqueuedPayload,
  NotificationFailedPayload,
  NotificationSentPayload,
  Phase1FixtureCiPendingPayload,
  Phase1FixtureCompletedPayload,
  Phase1FixtureFailedPayload,
  Phase1FixtureStartedPayload,
  ReviewApprovedPayload,
  ReviewChangesRequestedPayload,
  ReviewRequestedPayload
} from "./schemas/integrations.js";
import {
  RunCompletedPayload,
  RunFailedPayload,
  RunQueuedPayload,
  RunStartedPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskQueuedPayload,
  TaskStartedPayload
} from "./schemas/lifecycle.js";
import { RedactionRawAccessPayload } from "./schemas/redaction.js";

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

  // Planner role (legacy single-pass + Phase 2 subtask emission)
  "planner.started": PlannerStartedPayload,
  "planner.completed": PlannerCompletedPayload,
  "planner.failed": PlannerFailedPayload,
  "planner.subtasks.emitted": PlannerSubtasksEmittedPayload,

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

  // Auditor role
  "auditor.started": AuditorStartedPayload,
  "auditor.completed": AuditorCompletedPayload,
  "auditor.failed": AuditorFailedPayload,
  "auditor.verdict": AuditorVerdictPayload,

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

  // Phase 1 fixture orchestration
  "phase1.fixture.started": Phase1FixtureStartedPayload,
  "phase1.fixture.ci_pending": Phase1FixtureCiPendingPayload,
  "phase1.fixture.completed": Phase1FixtureCompletedPayload,
  "phase1.fixture.failed": Phase1FixtureFailedPayload,

  // Review lifecycle (schemas declared in Phase 2; emitters land later)
  "review.requested": ReviewRequestedPayload,
  "review.approved": ReviewApprovedPayload,
  "review.changes_requested": ReviewChangesRequestedPayload,

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
  "redaction.raw_access": RedactionRawAccessPayload
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
