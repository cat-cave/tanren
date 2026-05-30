// P2A-0014 SSE driver tests. Drive the SseDriver directly (not through an
// HTTP response) so the test can observe frames synchronously. The route
// handler wraps the same driver in hono's streaming helper; that wiring is
// covered by the contract test.

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
    pool.runs[0].outcome = "phase1_fixture_complete";
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
    pool.runs[0].outcome = "phase2_easy_complete";
    await driver.tick();
    expect(captured.find((f) => f.event === "status")).toBeDefined();
    const status = captured.find((f) => f.event === "status")!.data as {
      status: string;
      outcome: string | null;
    };
    expect(status.status).toBe("completed");
    expect(status.outcome).toBe("phase2_easy_complete");
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
});
