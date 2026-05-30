// P2A-0014 SSE handler — emits status/task/event/cost frames as the run
// progresses. v0 uses a poll-based source at 1s tick (acceptable per spec);
// the contract surface is shaped so a Postgres LISTEN/NOTIFY swap-in lands
// behind the same frame format.
//
// Frame format follows the SSE spec: `event: <name>\ndata: <json>\n\n`. The
// initial frame is `snapshot` carrying a partial RunDetail (run + tasks +
// recentEvents + costs). Subsequent frames are deltas. Heartbeats fire
// every 15s wall-clock when nothing else has been sent. The stream ends
// when the run reaches a terminal status AND one final post-terminal poll
// has flushed any remaining events/costs/tasks.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { ActorContext } from "../../auth/schemas.js";
import type { QueryClient } from "../../engine/data/orgScopedDb.js";
import {
  RECENT_EVENT_CAP,
  type RunCostRecord,
  type RunEventRow,
  type SseEventName,
  type TaskTimelineEntry,
} from "./contract.js";
import { fetchRunCostsForSnapshot, fetchRunEventsForSnapshot, fetchRunSummary, fetchRunTasks } from "./list.js";

interface SseStreamArgs {
  pool: pg.Pool;
  runId: string;
  projectId: string;
  // org_id is a defense-in-depth tenant predicate (tanren tenancy hardening):
  // every loader query and the SSE delta polls filter by it.
  orgId: string;
  actor: ActorContext;
  rawView: boolean;
  intervalMs: number;
  now?: () => Date;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
// Terminal statuses end the stream once a final post-terminal poll flushes
// remaining deltas. Matches the canonical Phase 2 transitions; "done" is
// kept for legacy fixture runs still pinned to the Phase 1 outcome.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "halted", "done"]);

const TERMINAL_GRACE_POLLS = 1;

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
  private lastEventId = 0;
  private lastCostId = 0;
  private lastTaskFingerprint = new Map<string, string>();
  private lastStatusFingerprint = "";
  private lastEmitAt: number;
  private terminalPollsRemaining: number | undefined;

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
    const snapshot = await runWithOrgScope(this.args.pool, this.args.orgId, async (client) => {
      const run = await fetchRunSummary(client, this.args.runId, this.args.orgId);
      if (run === undefined) return;
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
    });
    if (snapshot === undefined) {
      await this.emit("status", { runId: this.args.runId, status: "failed", outcome: null });
      return;
    }
    const { run, tasks, recentEvents, costs } = snapshot;
    await this.emit("snapshot", { run, tasks, recentEvents, costs });

    this.lastStatusFingerprint = `${run.status}:${run.outcome ?? ""}`;
    for (const task of tasks) {
      this.lastTaskFingerprint.set(task.taskId, fingerprintTask(task));
    }
    const lastEvent = recentEvents.at(-1);
    this.lastEventId = lastEvent === undefined ? 0 : Number(lastEvent.id);
    const lastCost = costs.at(-1);
    this.lastCostId = lastCost === undefined ? 0 : Number(lastCost.id);

    if (TERMINAL_STATUSES.has(run.status)) {
      this.terminalPollsRemaining = TERMINAL_GRACE_POLLS;
    }

    while (true) {
      await this.sleep(this.args.intervalMs);
      const stop = await this.tick();
      if (stop) return;
    }
  }

  // tick polls for deltas; returns true when the loop should terminate.
  async tick(): Promise<boolean> {
    // RLS R2 cohort-1: each poll batches its reads (runs + tasks + events deltas,
    // plus the still-pool-cohort cost deltas) into one short org-scoped
    // transaction. Inert in R1; same rows as the pool path.
    const polled = await runWithOrgScope(this.args.pool, this.args.orgId, async (client) => {
      const run = await fetchRunSummary(client, this.args.runId, this.args.orgId);
      if (run === undefined) return;
      const tasks = await fetchRunTasks(client, this.args.runId, this.args.orgId);
      const newEvents = await this.pollNewEvents(client);
      const newCosts = await this.pollNewCosts(client);
      return { run, tasks, newEvents, newCosts };
    });
    if (polled === undefined) return true;
    const { run, tasks, newEvents, newCosts } = polled;
    const fp = `${run.status}:${run.outcome ?? ""}`;
    if (fp !== this.lastStatusFingerprint) {
      await this.emit("status", { runId: run.runId, status: run.status, outcome: run.outcome });
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
    for (const task of changed) {
      await this.emit("task", task);
    }
    const lastNewEvent = newEvents.at(-1);
    if (lastNewEvent !== undefined) {
      await this.emit("events", { events: newEvents });
      this.lastEventId = Number(lastNewEvent.id);
    }
    const lastNewCost = newCosts.at(-1);
    if (lastNewCost !== undefined) {
      await this.emit("costs", { costs: newCosts });
      this.lastCostId = Number(lastNewCost.id);
    }
    if (this.nowMs() - this.lastEmitAt >= HEARTBEAT_INTERVAL_MS) {
      await this.emit("heartbeat", { ts: this.args.now?.() ?? new Date() });
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      if (this.terminalPollsRemaining === undefined) {
        this.terminalPollsRemaining = TERMINAL_GRACE_POLLS;
      } else if (this.terminalPollsRemaining <= 0) {
        return true;
      } else {
        this.terminalPollsRemaining -= 1;
      }
    }
    return false;
  }

  private async pollNewEvents(client: QueryClient): Promise<RunEventRow[]> {
    // Read new event rows by id > lastEventId. The redaction pass mirrors
    // the snapshot loader to keep payload shapes identical between the
    // initial frame and subsequent delta frames. RLS R2 cohort-1: runs on the
    // tick's ambient org-scoped client (events table).
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
         FROM events
        WHERE run_id = $1 AND org_id = $3 AND id > $2
        ORDER BY ts ASC, id ASC
        LIMIT 200`,
      [this.args.runId, this.lastEventId, this.args.orgId],
    );
    if (rows.length === 0) return [];
    // Re-use the redaction path through fetchRunEventsForSnapshot by giving
    // it a custom query; for simplicity we inline here.
    const { redactEventPayload } = await import("../../engine/redaction/index.js");
    const { isEventName } = await import("../../engine/events/index.js");
    const out: RunEventRow[] = [];
    for (const row of rows) {
      const eventType = String(row["event_type"]);
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
        id: row["id"] as number | string,
        ts: row["ts"] as Date,
        runId: row["run_id"] === null || row["run_id"] === undefined ? null : String(row["run_id"]),
        taskId: row["task_id"] === null || row["task_id"] === undefined ? null : String(row["task_id"]),
        specId: row["spec_id"] === null || row["spec_id"] === undefined ? null : String(row["spec_id"]),
        projectId: row["project_id"] === null || row["project_id"] === undefined ? null : String(row["project_id"]),
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
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, task_id, run_id, project_id, cli, provider, model,
              input_tokens, cached_input_tokens, cache_creation_tokens,
              output_tokens, reasoning_output_tokens, total_tokens, cost_usd,
              billing_mode, cost_basis, recorded_at
         FROM cost_records
        WHERE run_id = $1 AND org_id = $3 AND id > $2
        ORDER BY recorded_at ASC, id ASC
        LIMIT 200`,
      [this.args.runId, this.lastCostId, this.args.orgId],
    );
    return rows.map((row) => ({
      id: row["id"] as number | string,
      runId: String(row["run_id"]),
      taskId: String(row["task_id"]),
      projectId: String(row["project_id"]),
      cli: String(row["cli"]),
      provider: String(row["provider"]),
      model: String(row["model"]),
      inputTokens: Number(row["input_tokens"] ?? 0),
      cachedInputTokens: Number(row["cached_input_tokens"] ?? 0),
      cacheCreationTokens: Number(row["cache_creation_tokens"] ?? 0),
      outputTokens: Number(row["output_tokens"] ?? 0),
      reasoningOutputTokens: Number(row["reasoning_output_tokens"] ?? 0),
      totalTokens: Number(row["total_tokens"] ?? 0),
      costUsd: row["cost_usd"] === null || row["cost_usd"] === undefined ? null : String(row["cost_usd"]),
      billingMode: row["billing_mode"] as RunCostRecord["billingMode"],
      costBasis: row["cost_basis"] as RunCostRecord["costBasis"],
      recordedAt: row["recorded_at"] as Date,
    }));
  }

  private async emit(name: SseEventName, data: unknown): Promise<void> {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data, jsonDateReplacer)}\n\n`;
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

function fingerprintTask(task: TaskTimelineEntry): string {
  return [
    task.status,
    task.outcome ?? "",
    task.failureKind ?? "",
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
