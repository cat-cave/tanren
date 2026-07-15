/** Runtime authorities for run, spec, milestone, insight, and feed HTTP reads. */

import { z } from "zod";
import type {
  ProjectFeedItem,
  RunCostRecord,
  RunDetail,
  RunEventRow,
  RunListItem,
  RunSummary,
  TaskTimelineEntry,
} from "./http.gen.js";
import type { InsightSummary, MilestoneSummary, SpecSummary } from "./types.js";

export const RunStatusSchema = z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]);
export const RunOutcomeSchema = z
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

export const JsonRowIdSchema = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^(0|[1-9][0-9]*)$/u)]);

const runSummaryReadSchema = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: RunStatusSchema,
    outcome: RunOutcomeSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();
export const RunSummaryReadSchema: z.ZodType<RunSummary> = runSummaryReadSchema;

export const TaskTimelineEntryReadSchema: z.ZodType<TaskTimelineEntry> = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    kind: z.enum([
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
    ]),
    parentTaskId: z.string().nullable(),
    title: z.string(),
    status: z.enum(["queued", "claimed", "running", "done", "failed", "cancelled"]),
    outcome: z
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
      .nullable(),
    failureKind: z.string().nullable(),
    attempt: z.number().int().nonnegative(),
    cli: z.string().min(1),
    model: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
  })
  .strict();

export const RunEventRowReadSchema: z.ZodType<RunEventRow> = z
  .object({
    id: JsonRowIdSchema,
    ts: z.string().datetime(),
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    specId: z.string().nullable(),
    projectId: z.string().nullable(),
    eventType: z.string().min(1),
    payload: z.unknown(),
    redactedPaths: z.array(z.string()),
  })
  .strict();

export const RunCostRecordReadSchema: z.ZodType<RunCostRecord> = z
  .object({
    id: JsonRowIdSchema,
    runId: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    cli: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.string().min(1).nullable(),
    billingMode: z.enum(["per_token", "subscription", "self_hosted", "unattributed"]),
    costBasis: z.enum(["ccusage", "provider_response", "credits", "unknown", "unattributed"]),
    recordedAt: z.string().datetime(),
  })
  .strict();

export const RunListItemReadSchema: z.ZodType<RunListItem> = runSummaryReadSchema
  .extend({
    specTitle: z.string(),
    costTotalUsd: z.string(),
    lastEventAt: z.string().datetime().nullable(),
    needsReview: z.boolean(),
  })
  .strict();

export const RunListResponseSchema = z.object({ items: z.array(RunListItemReadSchema) }).strict();

const SpecTriageProvenanceSchema = z
  .object({
    parentSpecId: z.string().min(1),
    sourceFindingIds: z.array(z.string().min(1)),
    originTriageTaskId: z.string().min(1),
    originRunId: z.string().min(1),
  })
  .strict();

export const SpecSummaryReadSchema: z.ZodType<SpecSummary> = z
  .object({
    specId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    dependsOn: z.array(z.string()),
    status: z.string(),
    triageProvenance: SpecTriageProvenanceSchema.optional(),
  })
  .strict();
export const SpecListResponseSchema = z.object({ specs: z.array(SpecSummaryReadSchema) }).strict();

export const MilestoneSummaryReadSchema: z.ZodType<MilestoneSummary> = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    label: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    orderIndex: z.number().int(),
    eta: z.string().nullable(),
    status: z.string(),
  })
  .strict();
export const MilestoneListResponseSchema = z.object({ milestones: z.array(MilestoneSummaryReadSchema) }).strict();

const InsightActionReadSchema = z
  .object({
    label: z.string(),
    toolCall: z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  })
  .passthrough();

export const InsightSummaryReadSchema: z.ZodType<InsightSummary> = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["retry_hotspot", "model_mismatch", "pace_anomaly", "stuck", "review_stall", "ci_flaky"]),
    projectId: z.string().min(1),
    severity: z.enum(["info", "warn", "fail"]),
    title: z.string(),
    body: z.string(),
    payload: z.record(z.string(), z.unknown()).and(z.object({ kind: z.string() })),
    actions: z.array(InsightActionReadSchema),
    computedAt: z.string().datetime(),
    acknowledgedAt: z.string().datetime().nullable(),
  })
  .passthrough();
export const InsightListResponseSchema = z.object({ insights: z.array(InsightSummaryReadSchema) }).strict();

export const ProjectFeedItemReadSchema: z.ZodType<ProjectFeedItem> = z
  .object({
    eventType: z.string().min(1),
    id: JsonRowIdSchema,
    payload: z.unknown(),
    projectId: z.string().nullable(),
    redactedPaths: z.array(z.string()),
    runId: z.string().min(1),
    specId: z.string().nullable(),
    taskId: z.string().nullable(),
    ts: z.string().datetime(),
  })
  .passthrough();
export const FeedListResponseSchema = z.object({ items: z.array(ProjectFeedItemReadSchema) }).strict();

export const RunDetailReadSchema: z.ZodType<RunDetail> = z
  .object({
    run: RunSummaryReadSchema,
    spec: z
      .object({
        specId: z.string().min(1),
        title: z.string(),
        description: z.string(),
        behaviorIds: z.array(z.string().min(1)),
        milestoneId: z.string().nullable(),
      })
      .strict(),
    tasks: z.array(TaskTimelineEntryReadSchema),
    recentEvents: z.array(RunEventRowReadSchema),
    costs: z.array(RunCostRecordReadSchema),
    insights: z.array(z.unknown()),
    forgeThread: z
      .object({ threadId: z.string().min(1), recentTurns: z.array(z.unknown()) })
      .strict()
      .nullable(),
  })
  .strict();

export function decodeRead<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
