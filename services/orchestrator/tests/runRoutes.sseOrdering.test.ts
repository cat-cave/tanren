import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { SseDriver } from "../src/routes/runs/sse.js";
import { RunRoutesPool, type TaskRow } from "./helpers/runRoutesPool.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function parseFrame(frame: string): { event: string; data: unknown } | undefined {
  const eventMatch = /event:\s*(\S+)/u.exec(frame);
  const dataMatch = /data:\s*(.*)/u.exec(frame);
  if (eventMatch === null || dataMatch === null) return undefined;
  return { event: eventMatch[1]!, data: JSON.parse(dataMatch[1]!) };
}

function setup() {
  const pool = new RunRoutesPool();
  pool.seedProject({ project_id: "project_x", org_id: "org_acme" });
  pool.seedSpec({ spec_id: "spec_x", project_id: "project_x" });
  pool.seedRun({ run_id: "run_x", spec_id: "spec_x", project_id: "project_x", status: "running" });
  const seededTask = pool.seedTask({
    task_id: "task_x",
    run_id: "run_x",
    kind: "plan",
    title: "plan",
    status: "running",
    attempt: 0,
    cli: "codex",
    model: "model-x",
    started_at: new Date("2026-05-01T00:00:00.000Z"),
  });
  const frames: Array<{ event: string; data: unknown }> = [];
  const driver = new SseDriver(
    {
      pool: pool.asPgPool(),
      runId: "run_x",
      projectId: "project_x",
      orgId: "org_acme",
      actor,
      rawView: false,
      intervalMs: 0,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    },
    (frame) => {
      const parsed = parseFrame(frame);
      if (parsed !== undefined) frames.push(parsed);
    },
  );
  (driver as unknown as { lastStatusFingerprint: string }).lastStatusFingerprint = "running:";
  return { pool, seededTask, frames, driver };
}

describe("run SSE ordered/capped deltas", () => {
  it("delivers id-ordered 200-row pages and advances each exact cursor to the page tail", async () => {
    const { pool, frames, driver } = setup();
    await driver.tick();
    frames.length = 0;
    for (let id = 205; id >= 1; id -= 1) {
      const time = new Date(Date.UTC(2026, 4, 1, 0, 0, 206 - id));
      pool.seedEvent({
        id,
        run_id: "run_x",
        task_id: "task_x",
        project_id: "project_x",
        event_type: "test.delta",
        ts: time,
      });
      pool.seedCost({
        id,
        run_id: "run_x",
        task_id: "task_x",
        project_id: "project_x",
        recorded_at: time,
      });
    }

    await driver.tick();
    const events = frames.find((frame) => frame.event === "events")?.data as
      | { events: Array<{ id: number | string }>; eventCursor: string }
      | undefined;
    const costs = frames.find((frame) => frame.event === "costs")?.data as
      | { costs: Array<{ id: number | string }>; costCursor: string }
      | undefined;
    expect(events?.events).toHaveLength(200);
    expect(events?.events.map((row) => row.id)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(events?.eventCursor).toBe("200");
    expect(costs?.costs).toHaveLength(200);
    expect(costs?.costs.map((row) => row.id)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(costs?.costCursor).toBe("200");

    const deltaSql = pool.queries
      .filter(({ sql }) => /id > \$2/u.test(sql))
      .map(({ sql }) => sql.replaceAll(/\s+/gu, " ").trim());
    expect(deltaSql).toHaveLength(4);
    expect(deltaSql.slice(-2).every((sql) => sql.includes("ORDER BY id ASC") && sql.includes("LIMIT 200"))).toBe(true);

    frames.length = 0;
    await driver.tick();
    const eventTail = frames.find((frame) => frame.event === "events")?.data as
      | { events: Array<{ id: number | string }>; eventCursor: string }
      | undefined;
    const costTail = frames.find((frame) => frame.event === "costs")?.data as
      | { costs: Array<{ id: number | string }>; costCursor: string }
      | undefined;
    expect(eventTail?.events.map((row) => row.id)).toEqual([201, 202, 203, 204, 205]);
    expect(eventTail?.eventCursor).toBe("205");
    expect(costTail?.costs.map((row) => row.id)).toEqual([201, 202, 203, 204, 205]);
    expect(costTail?.costCursor).toBe("205");
  });

  const mutations: Array<[string, (row: TaskRow) => void]> = [
    ["taskId", (row) => (row.task_id = "task_changed")],
    ["runId/removal", (row) => (row.run_id = "run_other")],
    ["kind", (row) => (row.kind = "write")],
    ["parentTaskId", (row) => (row.parent_task_id = "task_parent")],
    ["title", (row) => (row.title = "changed")],
    ["status", (row) => (row.status = "done")],
    ["outcome", (row) => (row.outcome = "passed")],
    ["failureKind", (row) => (row.failure_kind = "audit_rejected")],
    ["attempt", (row) => (row.attempt = 2)],
    ["cli", (row) => (row.cli = "claude")],
    ["model", (row) => (row.model = "model-y")],
    ["startedAt", (row) => (row.started_at = new Date("2026-05-01T00:00:01.000Z"))],
    ["endedAt", (row) => (row.ended_at = new Date("2026-05-01T00:00:02.000Z"))],
  ];

  it.each(mutations)("emits a full task projection when %s changes", async (_field, mutate) => {
    const { seededTask, frames, driver } = setup();
    await driver.tick();
    frames.length = 0;
    mutate(seededTask);
    await driver.tick();
    const taskFrame = frames.find((frame) => frame.event === "task")?.data as
      | { tasks: unknown[]; taskWatermark: string }
      | undefined;
    expect(taskFrame).toBeDefined();
    expect(taskFrame?.taskWatermark).toMatch(/^[0-9a-f]{64}$/u);
    expect(taskFrame?.tasks).toHaveLength(seededTask.run_id === "run_x" ? 1 : 0);
  });

  it("requires a quiet terminal poll after emitting a task-removal projection", async () => {
    const { pool, frames, driver } = setup();
    await driver.tick();
    frames.length = 0;
    pool.runs[0]!.status = "completed";
    pool.runs[0]!.outcome = "ok";
    pool.tasks.length = 0;
    const internal = driver as unknown as { lastStatusFingerprint: string; terminalQuietArmed: boolean };
    internal.lastStatusFingerprint = "completed:ok";
    internal.terminalQuietArmed = true;

    expect(await driver.tick()).toBe(false);
    expect(frames.some((frame) => frame.event === "task")).toBe(true);
    expect(frames.some((frame) => frame.event === "drained")).toBe(false);

    expect(await driver.tick()).toBe(true);
    expect(frames.at(-1)?.event).toBe("drained");
  });
});
