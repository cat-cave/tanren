/** Runtime mirrors of the generated run-detail wire contract. */
import { z } from "zod";

export const RunStatusWire = z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]);
export const RunOutcomeWire = z
  .enum([
    "ok",
    "halted",
    "escape_hatch_hit",
    "retry_budget_exhausted",
    "convergence_stalled",
    "window_exhausted",
    "window_paused",
    "awaiting_review",
    "cancelled",
    "failed",
  ])
  .nullable();
export const TaskStatusWire = z.enum(["queued", "claimed", "running", "done", "failed", "cancelled"]);
export const TaskOutcomeWire = z
  .enum([
    "passed",
    "ok",
    "pending",
    "failed",
    "rejected_by_checker",
    "rejected_by_auditor",
    "timed_out",
    "crashed",
    "window_exhausted",
    "cancelled",
  ])
  .nullable();
const TaskKindWire = z.enum([
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  "review",
  "merge",
  "demo",
  "forge",
  "triage",
  "convergence",
  "designOracle",
]);
const BillingModeWire = z.enum(["per_token", "subscription", "self_hosted", "unattributed"]);
const CostBasisWire = z.enum(["ccusage", "provider_response", "credits", "unknown", "unattributed"]);
const BigserialWire = z.string().regex(/^[1-9]\d*$/u);
export const SseCursorWire = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const TimestampWire = z.string().datetime();
const SafeTokenWire = z.number().int().nonnegative().safe();

export const RunSummaryWire = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: RunStatusWire,
    outcome: RunOutcomeWire,
    startedAt: TimestampWire,
    endedAt: TimestampWire.nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();

export const TaskTimelineEntryWire = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    kind: TaskKindWire,
    parentTaskId: z.string().nullable(),
    title: z.string(),
    status: TaskStatusWire,
    outcome: TaskOutcomeWire,
    failureKind: z.string().nullable(),
    attempt: z.number().int().nonnegative().safe(),
    cli: z.string().min(1),
    model: z.string().nullable(),
    startedAt: TimestampWire.nullable(),
    endedAt: TimestampWire.nullable(),
  })
  .strict();

export const RunEventRowWire = z
  .object({
    id: BigserialWire,
    ts: TimestampWire,
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    specId: z.string().nullable(),
    projectId: z.string().nullable(),
    eventType: z.string().min(1),
    payload: z.unknown(),
    redactedPaths: z.array(z.string()),
  })
  .strict();

export const RunCostRecordWire = z
  .object({
    id: BigserialWire,
    runId: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    cli: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: SafeTokenWire,
    cachedInputTokens: SafeTokenWire,
    cacheCreationTokens: SafeTokenWire,
    outputTokens: SafeTokenWire,
    reasoningOutputTokens: SafeTokenWire,
    totalTokens: SafeTokenWire,
    costUsd: z
      .string()
      .regex(/^\d+(?:\.\d{1,6})?$/u)
      .nullable(),
    billingMode: BillingModeWire,
    costBasis: CostBasisWire,
    recordedAt: TimestampWire,
  })
  .strict();

export const RunDetailWire = z
  .object({
    run: RunSummaryWire,
    spec: z
      .object({
        specId: z.string().min(1),
        title: z.string(),
        description: z.string(),
        behaviorIds: z.array(z.string().min(1)),
        milestoneId: z.string().nullable(),
      })
      .strict(),
    tasks: z.array(TaskTimelineEntryWire),
    recentEvents: z.array(RunEventRowWire),
    costs: z.array(RunCostRecordWire),
    insights: z.array(z.unknown()),
    forgeThread: z
      .object({ threadId: z.string().min(1), recentTurns: z.array(z.unknown()) })
      .strict()
      .nullable(),
  })
  .strict();

const IdentityWire = {
  runId: z.string().min(1),
  projectId: z.string().min(1),
} as const;
const TaskWatermarkWire = z.string().regex(/^[a-f0-9]{64}$/u);

export const SseSnapshotFrameWire = z
  .object({
    ...IdentityWire,
    run: RunSummaryWire,
    tasks: z.array(TaskTimelineEntryWire),
    recentEvents: z.array(RunEventRowWire),
    costs: z.array(RunCostRecordWire),
    eventCursor: SseCursorWire,
    costCursor: SseCursorWire,
    taskWatermark: TaskWatermarkWire,
  })
  .strict();
export const SseStatusFrameWire = z
  .object({ ...IdentityWire, status: RunStatusWire, outcome: RunOutcomeWire })
  .strict();
export const SseTaskFrameWire = z
  .object({ ...IdentityWire, task: TaskTimelineEntryWire, taskWatermark: TaskWatermarkWire })
  .strict();
export const SseEventsFrameWire = z
  .object({ ...IdentityWire, events: z.array(RunEventRowWire), eventCursor: SseCursorWire })
  .strict();
export const SseCostsFrameWire = z
  .object({ ...IdentityWire, costs: z.array(RunCostRecordWire), costCursor: SseCursorWire })
  .strict();
export const SseHeartbeatFrameWire = z.object({ ...IdentityWire, ts: TimestampWire }).strict();
export const SseDrainedFrameWire = z
  .object({
    ...IdentityWire,
    status: RunStatusWire,
    outcome: RunOutcomeWire,
    eventCursor: SseCursorWire,
    costCursor: SseCursorWire,
    taskWatermark: TaskWatermarkWire,
  })
  .strict();

export type RunDetailWire = z.infer<typeof RunDetailWire>;
export type RunCostRecordWire = z.infer<typeof RunCostRecordWire>;
export type SseSnapshotFrameWire = z.infer<typeof SseSnapshotFrameWire>;
export type SseStatusFrameWire = z.infer<typeof SseStatusFrameWire>;
export type SseTaskFrameWire = z.infer<typeof SseTaskFrameWire>;
export type SseEventsFrameWire = z.infer<typeof SseEventsFrameWire>;
export type SseCostsFrameWire = z.infer<typeof SseCostsFrameWire>;
export type SseHeartbeatFrameWire = z.infer<typeof SseHeartbeatFrameWire>;
export type SseDrainedFrameWire = z.infer<typeof SseDrainedFrameWire>;
