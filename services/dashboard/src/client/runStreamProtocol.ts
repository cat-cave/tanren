/** Strict browser-side decoder and reducer for the run SSE protocol. */

import { z } from "zod";
import type {
  RunCostRecord,
  SseCostsFrame as GeneratedCostsFrame,
  SseDrainedFrame as GeneratedDrainedFrame,
  SseEventsFrame as GeneratedEventsFrame,
  SseHeartbeatFrame as GeneratedHeartbeatFrame,
  SseSnapshotFrame as GeneratedSnapshotFrame,
  SseStatusFrame as GeneratedStatusFrame,
  SseTaskFrame as GeneratedTaskFrame,
  TaskTimelineEntry,
} from "../api/http.gen.js";

const cursor = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const watermark = z.string().regex(/^[0-9a-f]{64}$/u);
const isoDate = z.string().datetime();
const status = z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]);
const outcome = z
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
const identity = { runId: z.string().min(1), projectId: z.string().min(1) } as const;

const run = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status,
    outcome,
    startedAt: isoDate,
    endedAt: isoDate.nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();

const task = z
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
    startedAt: isoDate.nullable(),
    endedAt: isoDate.nullable(),
  })
  .strict();

const eventRow = z
  .object({
    id: z.union([z.number().int().nonnegative(), cursor]),
    ts: isoDate,
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    specId: z.string().nullable(),
    projectId: z.string().nullable(),
    eventType: z.string().min(1),
    payload: z.unknown(),
    redactedPaths: z.array(z.string()),
  })
  .strict();

export const CostRecordFrameSchema: z.ZodType<RunCostRecord> = z
  .object({
    id: z.union([z.number().int().nonnegative(), cursor]),
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
    recordedAt: isoDate,
  })
  .strict();

export const SnapshotFrameSchema: z.ZodType<GeneratedSnapshotFrame> = z
  .object({
    ...identity,
    run,
    tasks: z.array(task),
    recentEvents: z.array(eventRow).max(50),
    costs: z.array(CostRecordFrameSchema),
    eventCursor: cursor,
    costCursor: cursor,
    taskWatermark: watermark,
  })
  .strict();
export const StatusFrameSchema: z.ZodType<GeneratedStatusFrame> = z.object({ ...identity, status, outcome }).strict();
export const TaskFrameSchema: z.ZodType<GeneratedTaskFrame> = z
  .object({ ...identity, tasks: z.array(task), taskWatermark: watermark })
  .strict();
export const EventsFrameSchema: z.ZodType<GeneratedEventsFrame> = z
  .object({ ...identity, events: z.array(eventRow).min(1).max(200), eventCursor: cursor })
  .strict();
export const CostsFrameSchema: z.ZodType<GeneratedCostsFrame> = z
  .object({ ...identity, costs: z.array(CostRecordFrameSchema).min(1).max(200), costCursor: cursor })
  .strict();
export const HeartbeatFrameSchema: z.ZodType<GeneratedHeartbeatFrame> = z.object({ ...identity, ts: isoDate }).strict();
export const DrainedFrameSchema: z.ZodType<GeneratedDrainedFrame> = z
  .object({ ...identity, status, outcome, eventCursor: cursor, costCursor: cursor, taskWatermark: watermark })
  .strict();

export type SnapshotFrame = GeneratedSnapshotFrame;
export type StatusFrame = GeneratedStatusFrame;
export type TaskFrame = GeneratedTaskFrame;
export type EventsFrame = GeneratedEventsFrame;
export type CostsFrame = GeneratedCostsFrame;
export type CostRecordFrame = RunCostRecord;

type RunStatus = z.infer<typeof status>;
type RunOutcome = z.infer<typeof outcome>;
const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled", "halted"]);

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export class RunStreamProtocol {
  private baseline = false;
  private eventCursor = "0";
  private costCursor = "0";
  private taskWatermark = "";
  private taskProjection = "";
  private terminalStatus: RunStatus | undefined;
  private terminalOutcome: RunOutcome | undefined;
  private closed = false;

  constructor(
    private readonly runId: string,
    private readonly projectId: string,
    initialStatus: string,
    initialOutcome: string | null,
  ) {
    const parsed = StatusFrameSchema.safeParse({ runId, projectId, status: initialStatus, outcome: initialOutcome });
    if (parsed.success && TERMINAL.has(parsed.data.status)) {
      this.terminalStatus = parsed.data.status;
      this.terminalOutcome = parsed.data.outcome;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isTerminal(): boolean {
    return this.terminalStatus !== undefined;
  }

  snapshot(value: unknown): ProtocolResult<SnapshotFrame> {
    const decoded = decode(SnapshotFrameSchema, value, "snapshot");
    if (!decoded.ok) return decoded;
    const frame = decoded.value;
    const identityError = this.identityError(frame);
    if (identityError !== undefined) return fail(identityError);
    if (frame.run.runId !== this.runId || frame.run.projectId !== this.projectId) return fail("snapshot run mismatch");
    if (frame.tasks.some((entry) => entry.runId !== this.runId)) return fail("snapshot task mismatch");
    if (
      frame.recentEvents.some(
        (entry) =>
          (entry.runId !== null && entry.runId !== this.runId) ||
          (entry.projectId !== null && entry.projectId !== this.projectId),
      )
    )
      return fail("snapshot event mismatch");
    if (frame.costs.some((entry) => entry.runId !== this.runId || entry.projectId !== this.projectId))
      return fail("snapshot cost mismatch");
    if (
      !cursorEqualsMaximum(
        frame.eventCursor,
        frame.recentEvents.map((entry) => entry.id),
      )
    )
      return fail("snapshot event cursor is not the exact row maximum");
    if (
      !cursorEqualsMaximum(
        frame.costCursor,
        frame.costs.map((entry) => entry.id),
      )
    )
      return fail("snapshot cost cursor is not the exact row maximum");
    if (this.baseline && !cursorAtLeast(frame.eventCursor, this.eventCursor))
      return fail("snapshot event cursor regressed");
    if (this.baseline && !cursorAtLeast(frame.costCursor, this.costCursor))
      return fail("snapshot cost cursor regressed");
    if (!uniqueTaskIds(frame.tasks)) return fail("snapshot contains duplicate task ids");
    const projection = canonicalTaskProjection(frame.tasks);
    if (
      this.baseline &&
      !watermarkMatchesProjectionChange(this.taskProjection, this.taskWatermark, projection, frame.taskWatermark)
    )
      return fail("snapshot task watermark does not match projection change");
    if (this.terminalStatus !== undefined && !this.matchesTerminal(frame.run.status, frame.run.outcome))
      return fail("snapshot attempted to replace terminal state");
    this.baseline = true;
    this.eventCursor = frame.eventCursor;
    this.costCursor = frame.costCursor;
    this.taskWatermark = frame.taskWatermark;
    this.taskProjection = projection;
    this.rememberTerminal(frame.run.status, frame.run.outcome);
    return decoded;
  }

  status(value: unknown): ProtocolResult<StatusFrame> {
    const decoded = decode(StatusFrameSchema, value, "status");
    if (!decoded.ok) return decoded;
    const identityError = this.identityError(decoded.value);
    if (identityError !== undefined) return fail(identityError);
    if (this.terminalStatus !== undefined && !this.matchesTerminal(decoded.value.status, decoded.value.outcome))
      return fail("status attempted to replace terminal state");
    this.rememberTerminal(decoded.value.status, decoded.value.outcome);
    return decoded;
  }

  task(value: unknown): ProtocolResult<TaskFrame> {
    const decoded = decode(TaskFrameSchema, value, "task");
    if (!decoded.ok) return decoded;
    const identityError = this.identityError(decoded.value);
    if (identityError !== undefined || decoded.value.tasks.some((entry) => entry.runId !== this.runId))
      return fail(identityError ?? "task run mismatch");
    if (!uniqueTaskIds(decoded.value.tasks)) return fail("task projection contains duplicate ids");
    const projection = canonicalTaskProjection(decoded.value.tasks);
    if (
      !watermarkMatchesProjectionChange(
        this.taskProjection,
        this.taskWatermark,
        projection,
        decoded.value.taskWatermark,
      )
    )
      return fail("task watermark does not match projection change");
    this.taskProjection = projection;
    this.taskWatermark = decoded.value.taskWatermark;
    return decoded;
  }

  events(value: unknown): ProtocolResult<EventsFrame> {
    const decoded = decode(EventsFrameSchema, value, "events");
    if (!decoded.ok) return decoded;
    const identityError = this.identityError(decoded.value);
    if (identityError !== undefined) return fail(identityError);
    if (
      decoded.value.events.some(
        (entry) =>
          (entry.runId !== null && entry.runId !== this.runId) ||
          (entry.projectId !== null && entry.projectId !== this.projectId),
      )
    )
      return fail("event run mismatch");
    if (
      !exactDelta(
        decoded.value.eventCursor,
        this.eventCursor,
        decoded.value.events.map((entry) => entry.id),
      )
    )
      return fail("event cursor is not the exact monotonic delta tail");
    this.eventCursor = decoded.value.eventCursor;
    return decoded;
  }

  costs(value: unknown): ProtocolResult<CostsFrame> {
    const decoded = decode(CostsFrameSchema, value, "costs");
    if (!decoded.ok) return decoded;
    const identityError = this.identityError(decoded.value);
    if (identityError !== undefined) return fail(identityError);
    if (decoded.value.costs.some((entry) => entry.runId !== this.runId || entry.projectId !== this.projectId))
      return fail("cost identity mismatch");
    if (
      !exactDelta(
        decoded.value.costCursor,
        this.costCursor,
        decoded.value.costs.map((entry) => entry.id),
      )
    )
      return fail("cost cursor is not the exact monotonic delta tail");
    this.costCursor = decoded.value.costCursor;
    return decoded;
  }

  heartbeat(value: unknown): ProtocolResult<z.infer<typeof HeartbeatFrameSchema>> {
    const decoded = decode(HeartbeatFrameSchema, value, "heartbeat");
    if (!decoded.ok) return decoded;
    const identityError = this.identityError(decoded.value);
    return identityError === undefined ? decoded : fail(identityError);
  }

  drained(value: unknown): ProtocolResult<z.infer<typeof DrainedFrameSchema>> {
    const decoded = decode(DrainedFrameSchema, value, "drained");
    if (!decoded.ok) return decoded;
    const frame = decoded.value;
    const identityError = this.identityError(frame);
    if (identityError !== undefined) return fail(identityError);
    if (!this.baseline || this.terminalStatus === undefined) return fail("drained arrived before terminal baseline");
    if (!this.matchesTerminal(frame.status, frame.outcome)) return fail("drained terminal mismatch");
    if (
      frame.eventCursor !== this.eventCursor ||
      frame.costCursor !== this.costCursor ||
      frame.taskWatermark !== this.taskWatermark
    )
      return fail("drained receipt does not match delivered state");
    this.closed = true;
    return decoded;
  }

  private identityError(value: { runId: string; projectId: string }): string | undefined {
    return value.runId !== this.runId || value.projectId !== this.projectId ? "stream identity mismatch" : undefined;
  }

  private rememberTerminal(nextStatus: RunStatus, nextOutcome: RunOutcome): void {
    if (TERMINAL.has(nextStatus)) {
      this.terminalStatus = nextStatus;
      this.terminalOutcome = nextOutcome;
    }
  }

  private matchesTerminal(nextStatus: RunStatus, nextOutcome: RunOutcome): boolean {
    return nextStatus === this.terminalStatus && nextOutcome === this.terminalOutcome;
  }
}

function decode<T>(schema: z.ZodType<T>, value: unknown, name: string): ProtocolResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : fail(`malformed ${name} frame`);
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function canonicalId(value: number | string): bigint | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  return /^(0|[1-9][0-9]*)$/u.test(value) ? BigInt(value) : undefined;
}

function cursorAtLeast(left: string, right: string): boolean {
  return BigInt(left) >= BigInt(right);
}

function cursorEqualsMaximum(value: string, ids: ReadonlyArray<number | string>): boolean {
  if (ids.length === 0) return value === "0";
  let maximum = -1n;
  for (const id of ids) {
    const parsed = canonicalId(id);
    if (parsed === undefined) return false;
    if (parsed > maximum) maximum = parsed;
  }
  return BigInt(value) === maximum;
}

function exactDelta(cursorValue: string, previousCursor: string, ids: ReadonlyArray<number | string>): boolean {
  if (ids.length === 0) return false;
  let prior = BigInt(previousCursor);
  for (const id of ids) {
    const parsed = canonicalId(id);
    if (parsed === undefined || parsed <= prior) return false;
    prior = parsed;
  }
  return BigInt(cursorValue) === prior;
}

function uniqueTaskIds(tasks: ReadonlyArray<TaskTimelineEntry>): boolean {
  return new Set(tasks.map((entry) => entry.taskId)).size === tasks.length;
}

function canonicalTaskProjection(tasks: ReadonlyArray<TaskTimelineEntry>): string {
  return JSON.stringify(
    [...tasks]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((entry) => [
        entry.taskId,
        entry.runId,
        entry.kind,
        entry.parentTaskId,
        entry.title,
        entry.status,
        entry.outcome,
        entry.failureKind,
        entry.attempt,
        entry.cli,
        entry.model,
        entry.startedAt,
        entry.endedAt,
      ]),
  );
}

function watermarkMatchesProjectionChange(
  previousProjection: string,
  previousWatermark: string,
  nextProjection: string,
  nextWatermark: string,
): boolean {
  return previousProjection === nextProjection
    ? previousWatermark === nextWatermark
    : previousWatermark !== nextWatermark;
}
