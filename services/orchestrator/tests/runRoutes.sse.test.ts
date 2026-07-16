// SSE driver tests. Drive the SseDriver directly (not through an
// HTTP response) so the test can observe frames synchronously. The route
// handler wraps the same driver in hono's streaming helper; that wiring is
// covered by the contract test.

import { RUN_ACTIVITY_CHANNEL, type PgNotifyListener } from "@tanren/db";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { SseDriver } from "../src/routes/runs/sse.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

// A fake LISTEN/NOTIFY listener that captures the channel + handler so a test
// can simulate an inbound `tanren_run` NOTIFY for a given run id.
function fakeListener(): {
  listener: PgNotifyListener;
  channel: () => string | undefined;
  fire: (payload: string) => void;
} {
  let subscribedChannel: string | undefined;
  let handler: ((payload: string) => void) | undefined;
  const listener = {
    async subscribe(channel: string, h: (payload: string) => void) {
      subscribedChannel = channel;
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    async close() {},
  } as unknown as PgNotifyListener;
  return { listener, channel: () => subscribedChannel, fire: (payload) => handler?.(payload) };
}

function setup() {
  const pool = new RunRoutesPool();
  pool.seedProject({ project_id: "project_x", org_id: "org_acme" });
  pool.seedSpec({ spec_id: "spec_x", project_id: "project_x" });
  pool.seedRun({ run_id: "run_x", spec_id: "spec_x", project_id: "project_x", status: "running" });
  pool.seedTask({
    task_id: "task_plan",
    run_id: "run_x",
    kind: "plan",
    status: "running",
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
  return { pool, frames, driver };
}

function parseFrame(frame: string): { event: string; data: unknown } | undefined {
  const eventMatch = /event:\s*(\S+)/u.exec(frame);
  const dataMatch = /data:\s*(.*)/u.exec(frame);
  if (eventMatch === null || dataMatch === null) return undefined;
  return { event: eventMatch[1], data: JSON.parse(dataMatch[1]) };
}

describe("P2A-0014 SSE driver", () => {
  it("emits a snapshot frame with run + tasks + recentEvents + costs", async () => {
    const { driver, frames } = setup();
    // Drive a single tick — manually call run() then break early by killing
    // the loop via terminal status.
    // We can short-circuit by calling the snapshot prelude through tick();
    // instead, drive run() with terminal status already set so it bails.
    const { pool } = setup();
    pool.runs[0].status = "completed";
    pool.runs[0].outcome = "ok";
    const localFrames: Array<{ event: string; data: unknown }> = [];
    const localDriver = new SseDriver(
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
        if (parsed !== undefined) localFrames.push(parsed);
      },
    );
    await localDriver.run();
    expect(localFrames[0]?.event).toBe("snapshot");
    const snapshot = localFrames[0].data as { run: { runId: string }; tasks: unknown[] };
    expect(snapshot.run.runId).toBe("run_x");
    expect(Array.isArray(snapshot.tasks)).toBe(true);
    // Driver should stop after grace polls.
    expect(localFrames.some((f) => f.event === "heartbeat")).toBe(false);
    expect(driver).toBeDefined();
    expect(frames).toBeDefined();
  });

  it("resumes cost deltas past Number.MAX_SAFE_INTEGER without skip or replay", async () => {
    const pool = new RunRoutesPool();
    pool.seedProject({ project_id: "project_big", org_id: "org_acme" });
    pool.seedSpec({ spec_id: "spec_big", project_id: "project_big" });
    pool.seedRun({ run_id: "run_big", spec_id: "spec_big", project_id: "project_big", status: "running" });
    // Number.MAX_SAFE_INTEGER + 2 — must stay exact decimal text end-to-end.
    const huge = "9007199254740993";
    const next = "9007199254740994";
    pool.seedCost({
      id: huge,
      run_id: "run_big",
      task_id: "task_1",
      project_id: "project_big",
      input_tokens: 1,
      total_tokens: 1,
      cost_usd: "0.01",
    });
    const captured: Array<{ event: string; data: unknown }> = [];
    const driver = new SseDriver(
      {
        pool: pool.asPgPool(),
        runId: "run_big",
        projectId: "project_big",
        orgId: "org_acme",
        actor,
        rawView: false,
        intervalMs: 0,
        now: () => new Date("2026-05-01T00:00:00.000Z"),
      },
      (frame) => {
        const parsed = parseFrame(frame);
        if (parsed !== undefined) captured.push(parsed);
      },
    );
    // Snapshot would set lastCostId from the huge id as exact decimal text.
    (driver as unknown as { lastCostId: string }).lastCostId = huge;
    (driver as unknown as { lastStatusFingerprint: string }).lastStatusFingerprint = "running:";
    pool.seedCost({
      id: next,
      run_id: "run_big",
      task_id: "task_2",
      project_id: "project_big",
      input_tokens: 2,
      total_tokens: 2,
      cost_usd: "0.02",
    });
    await driver.tick();
    const costsFrame = captured.find((f) => f.event === "costs");
    expect(costsFrame).toBeDefined();
    const costs = (costsFrame!.data as { costs: Array<{ id: string | number }> }).costs;
    expect(costs.map((c) => String(c.id))).toEqual([next]);
    // A second tick must not re-emit the same cost (no double count / replay).
    const before = captured.filter((f) => f.event === "costs").length;
    await driver.tick();
    expect(captured.filter((f) => f.event === "costs").length).toBe(before);
    // Cursor state stayed exact decimal text (no Number() precision loss).
    expect((driver as unknown as { lastCostId: string }).lastCostId).toBe(next);
  });

  it("emits a status frame when the run's status changes between ticks", async () => {
    const pool = new RunRoutesPool();
    pool.seedRun({
      run_id: "run_y",
      spec_id: "spec_y",
      project_id: "project_y",
      status: "running",
    });
    const captured: Array<{ event: string; data: unknown }> = [];
    const driver = new SseDriver(
      {
        pool: pool.asPgPool(),
        runId: "run_y",
        projectId: "project_y",
        orgId: "org_acme",
        actor,
        rawView: false,
        intervalMs: 0,
        now: () => new Date("2026-05-01T00:00:00.000Z"),
      },
      (frame) => {
        const parsed = parseFrame(frame);
        if (parsed !== undefined) captured.push(parsed);
      },
    );
    // Manually call internal methods via run; need a partially-initialized
    // driver state. Instead, drive snapshot then mutate then tick.
    // Use Reflect to seed the internal fingerprints minimally.
    // Easiest: call tick() directly after pre-seeding snapshot.
    (driver as unknown as { lastStatusFingerprint: string }).lastStatusFingerprint = "running:";
    pool.runs[0].status = "completed";
    pool.runs[0].outcome = "ok";
    await driver.tick();
    expect(captured.find((f) => f.event === "status")).toBeDefined();
    const status = captured.find((f) => f.event === "status")!.data as {
      status: string;
      outcome: string | null;
    };
    expect(status.status).toBe("completed");
    expect(status.outcome).toBe("ok");
  });

  it("emits a heartbeat after the configured interval passes without other frames", async () => {
    const pool = new RunRoutesPool();
    pool.seedRun({
      run_id: "run_h",
      spec_id: "spec_h",
      project_id: "project_h",
      status: "running",
    });
    let nowMs = 0;
    const captured: Array<{ event: string; data: unknown }> = [];
    const driver = new SseDriver(
      {
        pool: pool.asPgPool(),
        runId: "run_h",
        projectId: "project_h",
        orgId: "org_acme",
        actor,
        rawView: false,
        intervalMs: 0,
        now: () => new Date(nowMs),
      },
      (frame) => {
        const parsed = parseFrame(frame);
        if (parsed !== undefined) captured.push(parsed);
      },
    );
    (driver as unknown as { lastStatusFingerprint: string }).lastStatusFingerprint = "running:";
    // Advance simulated clock past the 15s heartbeat threshold.
    nowMs = 20_000;
    await driver.tick();
    expect(captured.some((f) => f.event === "heartbeat")).toBe(true);
  });

  it("subscribes to the run-activity channel and wakes the loop on this run's NOTIFY", async () => {
    const pool = new RunRoutesPool();
    pool.seedProject({ project_id: "project_n", org_id: "org_acme" });
    pool.seedSpec({ spec_id: "spec_n", project_id: "project_n" });
    pool.seedRun({ run_id: "run_n", spec_id: "spec_n", project_id: "project_n", status: "running" });
    const { listener, channel, fire } = fakeListener();
    const captured: Array<{ event: string; data: unknown }> = [];
    const driver = new SseDriver(
      {
        pool: pool.asPgPool(),
        runId: "run_n",
        projectId: "project_n",
        orgId: "org_acme",
        actor,
        rawView: false,
        // LONG backstop: the loop must advance on the NOTIFY wake, not the poll.
        intervalMs: 60_000,
        notifyListener: listener,
        now: () => new Date("2026-05-01T00:00:00.000Z"),
      },
      (frame) => {
        const parsed = parseFrame(frame);
        if (parsed !== undefined) captured.push(parsed);
      },
    );

    const done = driver.run();
    // Let run() emit the snapshot and park in waitForActivity().
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(captured[0]?.event).toBe("snapshot");
    expect(channel()).toBe(RUN_ACTIVITY_CHANNEL);

    // Move the run terminal, then fire THIS run's NOTIFY: the parked loop wakes,
    // ticks, emits the status delta, and (terminal grace) ends — all without the
    // 60s backstop elapsing.
    pool.runs[0].status = "completed";
    pool.runs[0].outcome = "ok";
    fire("run_n");

    await done;
    const status = captured.find((f) => f.event === "status")?.data as { status: string } | undefined;
    expect(status?.status).toBe("completed");
  });

  it("ignores a NOTIFY for a DIFFERENT run (payload filter)", async () => {
    const pool = new RunRoutesPool();
    pool.seedProject({ project_id: "project_f", org_id: "org_acme" });
    pool.seedSpec({ spec_id: "spec_f", project_id: "project_f" });
    pool.seedRun({ run_id: "run_f", spec_id: "spec_f", project_id: "project_f", status: "running" });
    const { listener, fire } = fakeListener();
    const captured: Array<{ event: string; data: unknown }> = [];
    const driver = new SseDriver(
      {
        pool: pool.asPgPool(),
        runId: "run_f",
        projectId: "project_f",
        orgId: "org_acme",
        actor,
        rawView: false,
        intervalMs: 60_000,
        notifyListener: listener,
        now: () => new Date("2026-05-01T00:00:00.000Z"),
      },
      (frame) => {
        const parsed = parseFrame(frame);
        if (parsed !== undefined) captured.push(parsed);
      },
    );

    const done = driver.run();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    // A NOTIFY for a DIFFERENT run must NOT wake this loop: move run_f terminal,
    // fire the wrong run's id — the loop should still be parked (no status delta)
    // until we fire the right one.
    pool.runs[0].status = "completed";
    pool.runs[0].outcome = "ok";
    fire("run_other");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(captured.some((f) => f.event === "status")).toBe(false);

    // The correct run id wakes it and the loop ends.
    fire("run_f");
    await done;
    expect(captured.some((f) => f.event === "status")).toBe(true);
  });
});
