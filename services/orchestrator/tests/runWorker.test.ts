// P3-0001: real-system test for the dequeue→execute seam.
//
// This replaces the deleted direct-execution acceptance drivers
// (scripts/acceptance/easy.ts + medium.ts) with a test that proves the path
// the dashboard actually triggers: enqueue a run via createQueuedRunFromSpec,
// then run the worker's claim+execute path. The workflow itself
// (runPlannerLoopWorkflow) is driven with FAKE adapters + a fake usage probe
// (its existing buildAdapters/buildUsageProbe seams) plus a fake SSH/allocator,
// so no real Codex/SSH/GitHub is touched — but the worker's claim, the
// workflow body, the job-complete, and terminal run/task state are all real.
//
// The reusable workflow/seed/deps helpers live in ./helpers/workerExec.ts so
// the mutation-strengthening suite (runExecutor.test.ts) drives the same body.

import type { PgNotifyListener } from "@tanren/db";
import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { executeNextPlanJob, RunWorker } from "../src/engine/worker/index.js";
import { deps, passingGitHub, setupSeededRun } from "./helpers/workerExec.js";

// A fake LISTEN/NOTIFY listener that captures the subscribed handler so a test
// can fire a "job enqueued" wake on demand. `fire()` simulates an inbound
// NOTIFY on the job-queue channel.
function fakeListener(): { listener: PgNotifyListener; fire: () => void } {
  let handler: (() => void) | undefined;
  const listener = {
    async subscribe(_channel: string, h: () => void) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    async close() {},
  } as unknown as PgNotifyListener;
  return { listener, fire: () => handler?.() };
}

describe("run worker (dequeue→execute seam)", () => {
  it("claims the queued plan job, runs the workflow, completes the job, and lands a terminal run", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
    });

    const github = passingGitHub();
    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, github));

    expect(result).toMatchObject({ kind: "completed", runId: run.runId, outcome: "passed" });
    // Real terminal state on the run + the spec (workflow finalization).
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    expect(pool.specStatus).toBe("merged");
    // The job reached a terminal queue state (not left running).
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("heartbeats the claimed job's lease while the workflow runs (P3-0028)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
    });

    let heartbeats = 0;
    const original = jobQueue.heartbeat.bind(jobQueue);
    jobQueue.heartbeat = async (id: string, leaseMs?: number) => {
      heartbeats += 1;
      return original(id, leaseMs);
    };

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      // Fast heartbeat + a workflow that idles long enough to renew at least once.
      heartbeatIntervalMs: 5,
      leaseMs: 1_000,
      runWorkflow: async (input) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        return deps(pool, secrets, jobQueue, passingGitHub()).runWorkflow(input);
      },
    });

    expect(result.kind).toBe("completed");
    expect(heartbeats).toBeGreaterThan(0);
    // The heartbeat loop is stopped on completion — no lease left to reap.
    const reaped = await jobQueue.reapExpiredLeases({ now: new Date(Date.now() + 10_000) });
    expect(reaped).toEqual([]);
  });

  it("is idle when no plan job is queued", async () => {
    const { pool, secrets } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, passingGitHub()));
    expect(result.kind).toBe("idle");
  });

  it("fails the job and lands the run in a recoverable state when the workflow throws", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
    });

    const throwingDeps = {
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      // A generic throw the workflow surfaces as failed/failed; the worker must
      // re-finalize it into a recoverable halted state.
      runWorkflow: async () => {
        await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [
          run.runId,
        ]);
        throw new Error("boom");
      },
    };
    const result = await executeNextPlanJob(throwingDeps);

    expect(result.kind).toBe("failed");
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("drains in-flight work on stop and stops claiming", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
    });

    const results: string[] = [];
    const worker = new RunWorker(deps(pool, secrets, jobQueue, passingGitHub()), {
      concurrency: 1,
      // A real (short) idle poll so the slot doesn't busy-spin between the job
      // completing and stop() flipping the draining flag.
      pollIntervalMs: 50,
      onResult: (r) => {
        if (r.kind !== "idle") {
          results.push(r.kind);
        }
      },
    });
    worker.start();
    // Let the slot claim+execute the single job, then drain.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    await worker.stop();

    expect(worker.isDraining).toBe(true);
    expect(results).toContain("completed");
    expect(pool.runStatus.status).toBe("completed");
  });

  it("wakes an idle slot on a job-enqueued NOTIFY instead of waiting out the backstop", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    const { listener, fire } = fakeListener();

    const results: string[] = [];
    const worker = new RunWorker(deps(pool, secrets, jobQueue, passingGitHub()), {
      concurrency: 1,
      // A LONG backstop: if the slot only woke on the poll, this test would not
      // finish in time. It must wake on the NOTIFY fire below instead.
      pollIntervalMs: 60_000,
      notifyListener: listener,
      onResult: (r) => {
        if (r.kind !== "idle") results.push(r.kind);
      },
    });
    worker.start();
    // Let the slot drain the (empty) queue and park in the idle wait.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(results).toEqual([]);

    // Enqueue a job, then fire the wake — the parked slot must re-claim WITHOUT
    // waiting out the 60s backstop.
    await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {} });
    fire();

    // Poll for the woken execution (fast: the slot re-claimed on wake).
    for (let i = 0; i < 100 && results.length === 0; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(results).toContain("completed");
    expect(pool.runStatus.status).toBe("completed");

    await worker.stop();
  });
});
