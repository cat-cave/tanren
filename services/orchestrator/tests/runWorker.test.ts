// real-system test for the dequeue→execute seam.
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
import { executeNextPlanJob, type ExecuteJobResult, RunWorker } from "../src/engine/worker/index.js";
import { deps, enqueuePlanJob, passingGitHub, setupSeededRun } from "./helpers/workerExec.js";

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
  it("claims the plan job, completes the workflow, and hands the ready run to the native queue", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const github = passingGitHub();
    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, github));

    expect(result).toMatchObject({ kind: "completed", runId: run.runId, outcome: "passed" });
    // The worker completes after the first native-queue pass; only the coordinator may land the spec.
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    expect(pool.specStatus).toBe("in_flight");
    expect(pool.eventTypes).toContain("merge.scheduled");
    expect(pool.eventTypes).toContain("merge.queued");
    // The job reached a terminal queue state (not left running).
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("heartbeats the claimed job's lease while the workflow runs (P3-0028)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

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
    await enqueuePlanJob(jobQueue, run);

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
    await enqueuePlanJob(jobQueue, run);

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

  // RESILIENCE (the v25-apex crash class): a single POISONED job — a per-run workflow
  // throw (e.g. the invalid `.tanren/ci.yml` whose validation error reached the run) —
  // must FAIL THAT JOB + the run, and the WORKER must SURVIVE and keep claiming. One
  // run's data error can never crash the worker (which serves every run) or wedge the
  // queue. The slot loop's catch + the executor's per-run catch are what guarantee this.
  it("survives a per-run workflow throw (poisoned job): fails the run, keeps claiming, drains clean", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const results: ExecuteJobResult[] = [];
    const worker = new RunWorker(
      {
        ...deps(pool, secrets, jobQueue, passingGitHub()),
        // The per-run throw the worker must contain (NOT propagate to a crash).
        runWorkflow: async () => {
          throw new Error("poison: invalid .tanren/ci.yml reached the run");
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 30,
        onResult: (r) => results.push(r),
      },
    );
    worker.start();
    // Let the slot claim+execute the poisoned job, then poll (queue now empty).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });

    // The worker is STILL alive and looping (it reached an idle poll after the throw).
    expect(worker.isDraining).toBe(false);
    const failed = results.find((r) => r.kind === "failed");
    expect(failed).toBeDefined();
    expect((failed as { runId?: string }).runId).toBe(run.runId);
    // The run was finalized into a recoverable state — not left running/stuck.
    expect(pool.runStatus.status).toBe("halted");
    // The poisoned job did not wedge the queue: it reached a terminal queue state and
    // the worker is free to claim the next job.
    expect(results.some((r) => r.kind === "idle")).toBe(true);

    await worker.stop();
    expect(worker.isDraining).toBe(true);
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
    await enqueuePlanJob(jobQueue, run);
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
