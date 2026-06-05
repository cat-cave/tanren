// P2A-0014: Run-detail read API contract — single source of truth for the
// HTTP request/response shapes 2B dashboard surfaces consume. The shapes
// here are frozen at spec exit; changes require an addendum in
// docs/contracts/run-detail-api.md.
//
// Every field surfaced by a run-detail route is named and typed here. UI
// affordances ("displayLabel", "icon") do not leak into this module — the
// API ships data and the dashboard composes presentation.

import { z } from "zod";
import { RunOutcome, RunStatus } from "../../engine/state/run.js";
import { TaskKind, TaskOutcome, TaskStatus } from "../../engine/state/task.js";

// ---------------------------------------------------------------------------
// Run + task shapes
// ---------------------------------------------------------------------------

export const RunSummary = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: RunStatus,
    outcome: RunOutcome.nullable(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummary>;

export const TaskTimelineEntry = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    kind: TaskKind,
    parentTaskId: z.string().nullable(),
    title: z.string(),
    status: TaskStatus,
    outcome: TaskOutcome.nullable(),
    failureKind: z.string().nullable(),
    attempt: z.number().int().nonnegative(),
    cli: z.string().min(1),
    model: z.string().nullable(),
    startedAt: z.coerce.date().nullable(),
    endedAt: z.coerce.date().nullable(),
  })
  .strict();
export type TaskTimelineEntry = z.infer<typeof TaskTimelineEntry>;

// ---------------------------------------------------------------------------
// Event row (redacted-by-default)
// ---------------------------------------------------------------------------

// Event payloads are typed by EventRegistry on write; the API surface keeps
// `payload` as `unknown` because the redaction layer (P2A-0009) may strip or
// rewrite fields per actor scope. `redactedPaths` lists fields the
// serializer dropped so the dashboard can render a "hidden by redaction"
// hint without guessing.
export const RunEventRow = z
  .object({
    id: z.union([z.number(), z.string()]),
    ts: z.coerce.date(),
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    specId: z.string().nullable(),
    projectId: z.string().nullable(),
    eventType: z.string().min(1),
    payload: z.unknown(),
    redactedPaths: z.array(z.string()).default([]),
  })
  .strict();
export type RunEventRow = z.infer<typeof RunEventRow>;

// ---------------------------------------------------------------------------
// Cost record (typed CostRecord per P2A-0011)
// ---------------------------------------------------------------------------

export const RunCostRecord = z
  .object({
    id: z.union([z.number(), z.string()]),
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
    recordedAt: z.coerce.date(),
  })
  .strict();
export type RunCostRecord = z.infer<typeof RunCostRecord>;

// ---------------------------------------------------------------------------
// Spec embedded in run detail
// ---------------------------------------------------------------------------

export const RunSpecSummary = z
  .object({
    specId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    behaviorIds: z.array(z.string().min(1)),
    milestoneId: z.string().nullable(),
  })
  .strict();
export type RunSpecSummary = z.infer<typeof RunSpecSummary>;

// ---------------------------------------------------------------------------
// Forge data bundle for the run
// ---------------------------------------------------------------------------

export const RunForgeBundle = z
  .object({
    threadId: z.string().min(1),
    recentTurns: z.array(z.unknown()),
  })
  .strict();
export type RunForgeBundle = z.infer<typeof RunForgeBundle>;

// ---------------------------------------------------------------------------
// Full RunDetail response
// ---------------------------------------------------------------------------

export const RunDetail = z
  .object({
    run: RunSummary,
    spec: RunSpecSummary,
    tasks: z.array(TaskTimelineEntry),
    // Capped recent events (default RECENT_EVENT_CAP); pagination via /events.
    recentEvents: z.array(RunEventRow),
    costs: z.array(RunCostRecord),
    // Insight rows are validated by the P2A-0020 schema; kept as `unknown`
    // here so this contract stays decoupled from the InsightPayload union
    // (which may add kinds in addendums).
    insights: z.array(z.unknown()),
    forgeThread: RunForgeBundle.nullable(),
  })
  .strict();
export type RunDetail = z.infer<typeof RunDetail>;

// Recent-events cap on the RunDetail snapshot. Full pagination through
// /events provides the rest. Kept small so the snapshot response stays under
// a few hundred KB even on long-running runs.
export const RECENT_EVENT_CAP = 50;

// ---------------------------------------------------------------------------
// Run list item (project view recent runs + attention queue)
// ---------------------------------------------------------------------------

export const RunListItem = RunSummary.extend({
  specTitle: z.string(),
  costTotalUsd: z.string(),
  lastEventAt: z.coerce.date().nullable(),
  // True when the run is in a review state with an open PR — derived from
  // runs.outcome plus presence of pr_url. Drives the attention queue in the
  // project view without leaking UI-specific shaping into the API.
  needsReview: z.boolean(),
}).strict();
export type RunListItem = z.infer<typeof RunListItem>;

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

// CursorPage<T> wraps any item schema. Encoded cursors are opaque base64;
// `decodeCursor` rejects malformed input. Default page size 50, max 200.
export function CursorPage<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface DecodedCursor {
  ts: Date;
  id: number;
}

// Encoded cursor = base64("<isoTs>:<id>"). Tests treat it as an opaque token
// supplied by a prior response; callers should never construct it manually.
export function encodeCursor(input: { ts: Date | string; id: number | string }): string {
  const isoTs = input.ts instanceof Date ? input.ts.toISOString() : input.ts;
  const idStr = String(input.id);
  return Buffer.from(`${isoTs}:${idStr}`, "utf8").toString("base64");
}

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`invalid_cursor: ${reason}`);
  }
}

export function decodeCursor(value: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    throw new InvalidCursorError("not base64");
  }
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0) {
    throw new InvalidCursorError("missing separator");
  }
  const isoTs = decoded.slice(0, sep);
  const idStr = decoded.slice(sep + 1);
  const ts = new Date(isoTs);
  if (Number.isNaN(ts.getTime())) {
    throw new InvalidCursorError("bad timestamp");
  }
  const id = Number(idStr);
  if (!Number.isFinite(id) || !Number.isInteger(id)) {
    throw new InvalidCursorError("bad id");
  }
  return { ts, id };
}

export function parsePageSize(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// SSE frame contract
// ---------------------------------------------------------------------------

export const SseEventName = z.enum(["snapshot", "status", "task", "events", "costs", "heartbeat"]);
export type SseEventName = z.infer<typeof SseEventName>;

export const SseStatusFrame = z
  .object({
    runId: z.string(),
    status: RunStatus,
    outcome: RunOutcome.nullable(),
  })
  .strict();
export type SseStatusFrame = z.infer<typeof SseStatusFrame>;

export const SseTaskFrame = TaskTimelineEntry;
export type SseTaskFrame = TaskTimelineEntry;

export const SseEventsFrame = z
  .object({
    events: z.array(RunEventRow),
  })
  .strict();
export type SseEventsFrame = z.infer<typeof SseEventsFrame>;

export const SseCostsFrame = z
  .object({
    costs: z.array(RunCostRecord),
  })
  .strict();
export type SseCostsFrame = z.infer<typeof SseCostsFrame>;

export const SseHeartbeatFrame = z
  .object({
    ts: z.coerce.date(),
  })
  .strict();
export type SseHeartbeatFrame = z.infer<typeof SseHeartbeatFrame>;

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

// The project activity feed is a flat stream of events across every run in
// the project, ordered newest-first with cursor pagination. Items are the
// same RunEventRow shape (redacted) but carry the runId so the dashboard can
// link back to the originating run.
export const ProjectFeedItem = RunEventRow.extend({
  // RunEventRow.runId is nullable for org-scoped events; in the feed we
  // require a runId because the feed filters to events belonging to runs.
  runId: z.string().min(1),
}).strict();
export type ProjectFeedItem = z.infer<typeof ProjectFeedItem>;
