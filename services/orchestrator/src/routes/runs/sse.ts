// Run SSE driver. LISTEN/NOTIFY wakes the run-scoped delta poll; `intervalMs`
// remains only a missed-notification backstop. Every frame is schema-validated
// and identity-bound. A terminal run emits a cursor/task-bound `drained` receipt
// only after a quiet poll proves all post-terminal deltas were delivered.

import { RUN_ACTIVITY_CHANNEL, runWithOrgScope, type PgNotifyListener } from "@tanren/db";
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { ActorContext } from "../../auth/schemas.js";
import type { QueryClient } from "../../engine/data/orgScopedDb.js";
import {
  RECENT_EVENT_CAP,
  SseCostsFrame,
  SseDrainedFrame,
  SseEventsFrame,
  SseHeartbeatFrame,
  SseSnapshotFrame,
  SseStatusFrame,
  SseTaskFrame,
  type RunCostRecord,
  type RunEventRow,
  type RunSummary,
  type SseEventName,
  type TaskTimelineEntry,
} from "./contract.js";
import { CostStore, EventStore } from "../../engine/repositories/index.js";
import { RawEventRowSchema, scalarText } from "./rowSchemas.js";
import { systemActor } from "../../engine/state/actor.js";
import {
  decodeCostRow,
  fetchRunCostsForSnapshot,
  fetchRunEventsForSnapshot,
  fetchRunSummary,
  fetchRunTasks,
} from "./list.js";

interface SseStreamArgs {
  pool: pg.Pool;
  runId: string;
  projectId: string;
  // org_id is a defense-in-depth tenant predicate (tanren tenancy hardening):
  // every loader query and the SSE delta polls filter by it.
  orgId: string;
  actor: ActorContext;
  rawView: boolean;
  // Safety-net backstop interval between forced re-polls. With a `notifyListener`
  // wired this is NOT the primary driver — the stream wakes on `tanren_run`
  // NOTIFYs filtered to this run; the interval only bounds latency if a NOTIFY is
  // missed. Tests pass 0 to drive ticks manually.
  intervalMs: number;
  // LISTEN/NOTIFY wake source. When provided, the driver subscribes to the
  // `tanren_run` channel and wakes on this run's activity instead of waiting out
  // the full backstop interval. Omitted in tests (and any caller without a shared
  // LISTEN connection) — then the driver degrades to pure backstop polling,
  // behavior-identical to the pre-NOTIFY loop.
  notifyListener?: PgNotifyListener;
  now?: () => Date;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
// Canonical run terminals; a successful run ends at `completed`.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "halted"]);

// LISTEN/NOTIFY: once a run is terminal, the grace flush poll(s) run on this
// short delay (capped by `intervalMs`) instead of the long backstop, so the
// stream ends promptly rather than dangling for a full backstop interval.
const TERMINAL_FLUSH_DELAY_MS = 250;

export async function handleSseStream(c: Context, args: SseStreamArgs): Promise<Response> {
  return honoStream(c, async (writer) => {
    const driver = new SseDriver(args, async (frame) => {
      await writer.write(frame);
    });
    await driver.run();
  });
}

// SseDriver is split out so the test harness can drive it directly without a
// real HTTP response. The driver collects frames via a writer callback; the
// route handler hands it a streaming writer, tests hand it an array push.
export class SseDriver {
  private lastEventId = "0";
  private lastCostId = "0";
  private lastTaskFingerprint = new Map<string, string>();
  private lastTaskWatermark = taskWatermark([]);
  private lastStatusFingerprint = "";
  private lastEmitAt: number;
  private terminalQuietArmed = false;
  // LISTEN/NOTIFY wake gate: a NOTIFY for this run resolves the parked waiter so
  // the loop re-polls immediately instead of waiting out the backstop interval.
  private wakeWaiter: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly args: SseStreamArgs,
    private readonly write: (frame: string) => Promise<void> | void,
  ) {
    this.lastEmitAt = this.nowMs();
  }

  private nowMs(): number {
    return (this.args.now?.() ?? new Date()).getTime();
  }

  async run(): Promise<void> {
    // Initial snapshot frame. RLS R2 cohort-1: each SSE read batch runs in its
    // own short org-scoped transaction (`SET LOCAL app.current_org_id`), never a
    // long-lived one held across the poll loop's sleeps. Inert in R1 — same rows
    // as the pool path — and RLS-correct in R3.
    const snapshot = await runWithOrgScope(
      this.args.pool,
      this.args.orgId,
      async (
        client,
      ): Promise<
        { run: RunSummary; tasks: TaskTimelineEntry[]; recentEvents: RunEventRow[]; costs: RunCostRecord[] } | undefined
      > => {
        const run = await fetchRunSummary(client, this.args.runId, this.args.orgId);
        if (run === undefined) return undefined;
        const tasks = await fetchRunTasks(client, this.args.runId, this.args.orgId);
        const recentEvents = await fetchRunEventsForSnapshot(client, {
          runId: this.args.runId,
          orgId: this.args.orgId,
          limit: RECENT_EVENT_CAP,
          actor: this.args.actor,
          rawView: this.args.rawView,
        });
        const costs = await fetchRunCostsForSnapshot(client, this.args.runId, this.args.orgId);
        return { run, tasks, recentEvents, costs };
      },
    );
    if (snapshot === undefined || snapshot.run.projectId !== this.args.projectId) {
      await this.emit("status", {
        runId: this.args.runId,
        projectId: this.args.projectId,
        status: "failed",
        outcome: null,
      });
      return;
    }
    const { run, tasks, recentEvents, costs } = snapshot;
    for (const task of tasks) {
      this.lastTaskFingerprint.set(task.taskId, fingerprintTask(task));
    }
    this.lastTaskWatermark = taskWatermark(tasks);
    this.lastEventId = maxCursor(
      "0",
      recentEvents.map((event) => event.id),
    );
    this.lastCostId = maxCursor(
      "0",
      costs.map((cost) => cost.id),
    );
    await this.emit("snapshot", {
      runId: this.args.runId,
      projectId: this.args.projectId,
      run,
      tasks,
      recentEvents,
      costs,
      eventCursor: this.lastEventId,
      costCursor: this.lastCostId,
      taskWatermark: this.lastTaskWatermark,
    });

    this.lastStatusFingerprint = `${run.status}:${run.outcome ?? ""}`;

    if (TERMINAL_STATUSES.has(run.status)) {
      this.terminalQuietArmed = true;
    }

    // LISTEN/NOTIFY: subscribe AFTER the snapshot so any activity between the
    // snapshot read and the subscribe is still caught by the first backstop
    // poll, and any activity after it wakes the loop. Best-effort: a failed
    // subscribe leaves the stream on backstop polling, never wedged.
    await this.subscribeWake();
    try {
      while (true) {
        await this.waitForActivity();
        const stop = await this.tick();
        if (stop) return;
      }
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  private async subscribeWake(): Promise<void> {
    if (this.args.notifyListener === undefined) return;
    try {
      this.unsubscribe = await this.args.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
        // Filter on the payload (the run id) so a busy multi-run channel wakes
        // ONLY the streams watching the run that actually changed.
        if (payload === this.args.runId) {
          this.wakeWaiter?.();
        }
      });
    } catch {
      // No LISTEN connection — degrade to backstop polling.
    }
  }

  // Park until this run's NOTIFY wakes us OR the backstop interval elapses,
  // whichever comes first. With no listener wired this is just the interval
  // sleep (behavior-identical to the pre-NOTIFY loop).
  private async waitForActivity(): Promise<void> {
    // Terminal drain: the run already reached a terminal status and we owe the
    // grace flush poll(s). Those are NOT activity-driven — no further NOTIFY is
    // guaranteed — so flush them PROMPTLY (a short fixed delay, never the long
    // backstop) rather than parking on the wake. This keeps the stream's end
    // crisp instead of dangling for a full backstop interval, preserving the
    // pre-NOTIFY terminal-end latency.
    if (this.terminalQuietArmed) {
      await this.sleep(Math.min(this.args.intervalMs, TERMINAL_FLUSH_DELAY_MS));
      return;
    }
    if (this.args.notifyListener === undefined) {
      await this.sleep(this.args.intervalMs);
      return;
    }
    const woken = new Promise<void>((resolve) => {
      this.wakeWaiter = resolve;
    });
    try {
      await Promise.race([this.sleep(this.args.intervalMs), woken]);
    } finally {
      this.wakeWaiter = undefined;
    }
  }

  // tick polls for deltas; returns true when the loop should terminate.
  async tick(): Promise<boolean> {
    // RLS R2 cohort-1: each poll batches its reads (runs + tasks + events deltas,
    // plus the still-pool-cohort cost deltas) into one short org-scoped
    // transaction. Inert in R1; same rows as the pool path.
    const polled = await runWithOrgScope(
      this.args.pool,
      this.args.orgId,
      async (
        client,
      ): Promise<
        { run: RunSummary; tasks: TaskTimelineEntry[]; newEvents: RunEventRow[]; newCosts: RunCostRecord[] } | undefined
      > => {
        const run = await fetchRunSummary(client, this.args.runId, this.args.orgId);
        if (run === undefined) return undefined;
        const tasks = await fetchRunTasks(client, this.args.runId, this.args.orgId);
        const newEvents = await this.pollNewEvents(client);
        const newCosts = await this.pollNewCosts(client);
        return { run, tasks, newEvents, newCosts };
      },
    );
    if (polled === undefined) return true;
    const { run, tasks, newEvents, newCosts } = polled;
    const fp = `${run.status}:${run.outcome ?? ""}`;
    const statusChanged = fp !== this.lastStatusFingerprint;
    if (statusChanged) {
      await this.emit("status", {
        runId: run.runId,
        projectId: this.args.projectId,
        status: run.status,
        outcome: run.outcome,
      });
      this.lastStatusFingerprint = fp;
    }
    const changed: TaskTimelineEntry[] = [];
    for (const task of tasks) {
      const fpTask = fingerprintTask(task);
      if (this.lastTaskFingerprint.get(task.taskId) !== fpTask) {
        changed.push(task);
        this.lastTaskFingerprint.set(task.taskId, fpTask);
      }
    }
    const nextTaskWatermark = taskWatermark(tasks);
    // A full-projection watermark change also catches removal of a task. A
    // per-row fingerprint loop alone can only notice rows that still exist.
    const taskProjectionChanged = changed.length > 0 || nextTaskWatermark !== this.lastTaskWatermark;
    if (taskProjectionChanged) {
      await this.emit("task", {
        runId: run.runId,
        projectId: this.args.projectId,
        tasks,
        taskWatermark: nextTaskWatermark,
      });
    }
    this.lastTaskWatermark = nextTaskWatermark;
    if (newEvents.length > 0) {
      this.lastEventId = maxCursor(
        this.lastEventId,
        newEvents.map((event) => event.id),
      );
      await this.emit("events", {
        runId: run.runId,
        projectId: this.args.projectId,
        events: newEvents,
        eventCursor: this.lastEventId,
      });
    }
    if (newCosts.length > 0) {
      this.lastCostId = maxCursor(
        this.lastCostId,
        newCosts.map((cost) => cost.id),
      );
      await this.emit("costs", {
        runId: run.runId,
        projectId: this.args.projectId,
        costs: newCosts,
        costCursor: this.lastCostId,
      });
    }
    if (this.nowMs() - this.lastEmitAt >= HEARTBEAT_INTERVAL_MS) {
      await this.emit("heartbeat", {
        runId: run.runId,
        projectId: this.args.projectId,
        ts: this.args.now?.() ?? new Date(),
      });
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      const deliveredActivity = statusChanged || taskProjectionChanged || newEvents.length > 0 || newCosts.length > 0;
      if (deliveredActivity) {
        // A later quiet terminal poll is the proof that no post-terminal delta
        // remained behind the receipt.
        this.terminalQuietArmed = true;
      } else if (this.terminalQuietArmed) {
        await this.emit("drained", {
          runId: run.runId,
          projectId: this.args.projectId,
          status: run.status,
          outcome: run.outcome,
          eventCursor: this.lastEventId,
          costCursor: this.lastCostId,
          taskWatermark: this.lastTaskWatermark,
        });
        return true;
      } else {
        this.terminalQuietArmed = true;
      }
    } else {
      this.terminalQuietArmed = false;
    }
    return false;
  }

  private async pollNewEvents(client: QueryClient): Promise<RunEventRow[]> {
    // Read new event rows by id > lastEventId. The redaction pass mirrors
    // the snapshot loader to keep payload shapes identical between the
    // initial frame and subsequent delta frames. RLS R2 cohort-1: runs on the
    // tick's ambient org-scoped client (events table).
    const rows = await EventStore.selectNewForRunSince(
      client,
      { runId: this.args.runId, orgId: this.args.orgId, sinceId: this.lastEventId },
      systemActor,
    );
    if (rows.length === 0) return [];
    // Re-use the redaction path through fetchRunEventsForSnapshot by giving
    // it a custom query; for simplicity we inline here.
    const { redactEventPayload } = await import("../../engine/redaction/index.js");
    const { isEventName } = await import("../../engine/events/index.js");
    const out: RunEventRow[] = [];
    for (const row of rows) {
      // Decode the cursor-key id + event timestamp at the boundary into a real
      // Date (a malformed row throws here, never a laundered `as Date`).
      const decoded = RawEventRowSchema.parse(row);
      const eventType = scalarText(row["event_type"]);
      let payload: unknown = row["payload"];
      let redactedPaths: string[] = [];
      if (isEventName(eventType)) {
        const r = redactEventPayload({
          eventName: eventType,
          payload: row["payload"],
          actor: this.args.actor,
          rawView: this.args.rawView,
        });
        payload = r.payload;
        redactedPaths = r.redactedPaths;
      }
      out.push({
        id: decoded.id,
        ts: decoded.ts,
        runId: row["run_id"] === null || row["run_id"] === undefined ? null : scalarText(row["run_id"]),
        taskId: row["task_id"] === null || row["task_id"] === undefined ? null : scalarText(row["task_id"]),
        specId: row["spec_id"] === null || row["spec_id"] === undefined ? null : scalarText(row["spec_id"]),
        projectId: row["project_id"] === null || row["project_id"] === undefined ? null : scalarText(row["project_id"]),
        eventType,
        payload,
        redactedPaths,
      });
    }
    return out;
  }

  private async pollNewCosts(client: QueryClient): Promise<RunCostRecord[]> {
    // cost_records is a later cohort; it rides the same org-scoped client here
    // (inert) purely so the per-tick reads share one transaction.
    const rows = await CostStore.selectNewForRunSince(
      client,
      { runId: this.args.runId, orgId: this.args.orgId, sinceId: this.lastCostId },
      systemActor,
    );
    // Same boundary decode as the snapshot path — enums + tokens via Zod, no `as`.
    return rows.map((row) => decodeCostRow(row));
  }

  private async emit(name: SseEventName, data: unknown): Promise<void> {
    const validated = SSE_FRAME_SCHEMAS[name].parse(data);
    const frame = `event: ${name}\ndata: ${JSON.stringify(validated, jsonDateReplacer)}\n\n`;
    await this.write(frame);
    this.lastEmitAt = this.nowMs();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

const SSE_FRAME_SCHEMAS = {
  snapshot: SseSnapshotFrame,
  status: SseStatusFrame,
  task: SseTaskFrame,
  events: SseEventsFrame,
  costs: SseCostsFrame,
  heartbeat: SseHeartbeatFrame,
  drained: SseDrainedFrame,
} as const;

function canonicalCursor(value: number | string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("unsafe SSE cursor id");
    return String(value);
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("invalid SSE cursor id");
  return BigInt(value).toString();
}

function maxCursor(current: string, ids: ReadonlyArray<number | string>): string {
  let max = BigInt(current);
  for (const id of ids) {
    const candidate = BigInt(canonicalCursor(id));
    if (candidate > max) max = candidate;
  }
  return max.toString();
}

function taskWatermark(tasks: ReadonlyArray<TaskTimelineEntry>): string {
  const canonical = [...tasks]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => ({
      taskId: task.taskId,
      runId: task.runId,
      kind: task.kind,
      parentTaskId: task.parentTaskId,
      title: task.title,
      status: task.status,
      outcome: task.outcome,
      failureKind: task.failureKind,
      attempt: task.attempt,
      cli: task.cli,
      model: task.model,
      startedAt: task.startedAt?.toISOString() ?? null,
      endedAt: task.endedAt?.toISOString() ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function fingerprintTask(task: TaskTimelineEntry): string {
  return [
    task.taskId,
    task.runId,
    task.kind,
    task.parentTaskId ?? "",
    task.title,
    task.status,
    task.outcome ?? "",
    task.failureKind ?? "",
    String(task.attempt),
    task.cli,
    task.model ?? "",
    task.startedAt?.toISOString() ?? "",
    task.endedAt?.toISOString() ?? "",
  ].join("|");
}

// JSON.stringify drops the Date wrapper; we keep ISO strings so the
// dashboard can parse uniformly without sniffing the source field.
function jsonDateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
