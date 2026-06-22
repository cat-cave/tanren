// Mutation-strengthening behavior suite for the run executor (runExecutor.ts) +
// the RunWorker slot loop (runWorker.ts). Drives REAL observable outcomes — DB
// rows via the in-memory WorkerPool, claimed jobs, emitted events — through the
// fake-adapter workflow body (./helpers/workerExec.ts).

import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { executeNextPlanJob, type ExecuteJobResult, RunWorker } from "../src/engine/worker/index.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  establishJobOrgContext,
  JobOrgContextLostError,
} from "../src/engine/worker/runExecutor.js";
import {
  delay,
  deps,
  fakeWorkflowRunner,
  passingGitHub,
  RecordingAllocator,
  RecordingSsh,
  SEEDED_ORG_ID,
  setupSeededRun,
} from "./helpers/workerExec.js";
import { WorkerPool } from "./helpers/workerPool.js";

const ORG = "org_worker_test";

// A plan run ALWAYS carries an org (the worker fails closed on a null-org plan job),
// so the enqueue defaults to the seeded run's org (which `setupSeededRun` makes the
// pool report). A test exercising the fail-closed guard enqueues without an org
// directly (not via this helper).
async function enqueuePlanJob(
  jobQueue: FakeJobQueue,
  run: { runId: string; plannerTaskId: string },
  orgId: string = SEEDED_ORG_ID,
) {
  await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {}, orgId });
}

describe("run worker — org-scoped execution (runExecutor RLS seam)", () => {
  it("establishes the per-job org context, runs the workflow org-scoped, and completes", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    // Project + claimed job share ORG → the org !== null branches engage
    // (establish context, org-scoped workflow pool).
    pool.forcedProjectOrgId = ORG;
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run, ORG);

    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, passingGitHub()));

    expect(result).toMatchObject({ kind: "completed", runId: run.runId });
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
  });

  it("FAILS LOUD (fail-closed) when a claimed plan job carries no org_id — never BYPASSRLS", async () => {
    // Every plan run is a tenant run: `runs.org_id` is NOT NULL and a plan job's
    // org_id is stamped from the run at enqueue, so a claimed plan job ALWAYS carries
    // a concrete org. A null org is therefore a wiring bug — admitting it would load
    // the run's context + run the workflow under the BYPASSRLS system pool, silently
    // executing a tenant's work with RLS disabled. The guard rejects it BEFORE any
    // context load / workflow, so the run is never touched.
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    // Enqueue WITHOUT an org_id (bypassing the org-defaulting helper) → a null-org
    // plan job, the wiring bug the guard must reject.
    await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {} });

    let workflowRan = false;
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async (input) => {
        // Must be UNREACHABLE — the fail-closed guard rejects the org-less job first.
        workflowRan = true;
        return fakeWorkflowRunner(passingGitHub())(input);
      },
    });

    expect(result).toMatchObject({ kind: "failed", runId: run.runId, failure: { kind: "missing_job_org" } });
    expect((result as { failure: { message: string } }).failure.message).toContain("must carry org scope");
    // The workflow never ran and the run was never executed/finalized — it stays
    // exactly as enqueued (`queued`), untouched, rather than running cross-RLS.
    expect(workflowRan).toBe(false);
    expect(pool.runStatus).toEqual({ status: "queued", outcome: null });
    // The org-less job is failed (terminal), not left claimable for a silent retry.
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("fails the job loudly when the claimed run is not reachable under its own org (JobOrgContextLost)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    pool.forcedProjectOrgId = ORG;
    // The reachability SELECT returns no row for this run → establishJobOrgContext
    // throws JobOrgContextLostError before any workflow work.
    pool.orgVisibleRunIds = new Set();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run, ORG);

    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, passingGitHub()));

    expect(result).toMatchObject({ kind: "failed", runId: run.runId });
    expect((result as { failure: { kind: string } }).failure.kind).toBe("JobOrgContextLostError");
    // The catch-path recoverable-finalize ran org-scoped (org known from the claim).
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("fails the job when the plan job is missing a run id — before any heartbeat/context work", async () => {
    const { pool, secrets } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ taskKind: "plan", payload: {} });

    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, passingGitHub()));

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "invalid_job" } });
    expect((result as { runId?: string }).runId).toBeUndefined();
    // The job is failed (terminal), not left claimable.
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });
});

describe("establishJobOrgContext (runExecutor)", () => {
  it("resolves when the run is reachable under its org GUC", async () => {
    const { pool, run } = await setupSeededRun();
    await expect(establishJobOrgContext(pool.asPgPool(), ORG, run.runId)).resolves.toBeUndefined();
  });

  it("throws JobOrgContextLostError when the run is NOT reachable under its org", async () => {
    const { pool } = await setupSeededRun();
    pool.orgVisibleRunIds = new Set();
    await expect(establishJobOrgContext(pool.asPgPool(), ORG, "run_missing")).rejects.toBeInstanceOf(
      JobOrgContextLostError,
    );
  });
});

describe("run worker — failure classification + heartbeat (runExecutor)", () => {
  it("classifies a named error by its name and carries the real message", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    class CustomBoomError extends Error {
      constructor() {
        super("custom boom message");
        this.name = "CustomBoomError";
      }
    }
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        throw new CustomBoomError();
      },
    });

    expect(result).toMatchObject({
      kind: "failed",
      failure: { kind: "CustomBoomError", message: "custom boom message" },
    });
  });

  it("classifies a bare Error (default name) as run_execution_failed", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        throw new Error("plain failure");
      },
    });

    expect(result).toMatchObject({
      kind: "failed",
      failure: { kind: "run_execution_failed", message: "plain failure" },
    });
  });

  it("classifies a non-Error throw as run_execution_failed and stringifies it", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        // eslint-disable-next-line no-throw-literal -- INTENTIONAL: this test pins the SUT's contract for non-Error throws (paired with the `bare Error` test above); wrapping in `new Error` would defeat the assertion at line 192.
        throw "string failure";
      },
    });

    expect(result).toMatchObject({
      kind: "failed",
      failure: { kind: "run_execution_failed", message: "string failure" },
    });
  });

  it("emits run.failed on the worker-level recoverable finalize", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [
          run.runId,
        ]);
        throw new Error("boom");
      },
    });

    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(pool.eventTypes).toContain("run.failed");
  });

  it("renews the lease at the configured interval and stops on completion", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const beats: number[] = [];
    const original = jobQueue.heartbeat.bind(jobQueue);
    jobQueue.heartbeat = async (id: string, leaseMs?: number) => {
      beats.push(leaseMs ?? -1);
      return original(id, leaseMs);
    };

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      heartbeatIntervalMs: 3,
      leaseMs: 777,
      runWorkflow: async (input) => {
        await delay(25);
        return fakeWorkflowRunner(passingGitHub())(input);
      },
    });

    expect(result.kind).toBe("completed");
    // Each heartbeat renewed with the configured lease window (not the default).
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((ms) => ms === 777)).toBe(true);
    // Stopped on completion — no lease left to reap.
    expect(await jobQueue.reapExpiredLeases({ now: new Date(Date.now() + 10_000) })).toEqual([]);
  });

  it("does not heartbeat when the workflow finishes before the first interval elapses", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    let beats = 0;
    const original = jobQueue.heartbeat.bind(jobQueue);
    jobQueue.heartbeat = async (id: string, leaseMs?: number) => {
      beats += 1;
      return original(id, leaseMs);
    };

    // A long interval the (fast) workflow never reaches → stopHeartbeat clears
    // the pending timer with no beat fired.
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      heartbeatIntervalMs: 60_000,
    });

    expect(result.kind).toBe("completed");
    expect(beats).toBe(0);
  });
});

describe("run worker — claim seam + default option fallbacks (runExecutor)", () => {
  it("claims through an injected claimClient (the plane-split P2 seam) rather than the jobQueue directly", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const claims: Array<{ taskKind: string; leaseMs?: number }> = [];
    const claimClient = {
      async claimJob(options: { taskKind: string; runId?: string; leaseMs?: number }) {
        claims.push({ taskKind: options.taskKind, leaseMs: options.leaseMs });
        return jobQueue.claim(options.taskKind, options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs });
      },
    };

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      claimClient,
      leaseMs: 4_242,
    });

    expect(result.kind).toBe("completed");
    // The claim went through the injected client with the configured lease.
    expect(claims).toEqual([{ taskKind: "plan", leaseMs: 4_242 }]);
  });

  it("defaults leaseMs and heartbeat interval to the exported constants when unset", () => {
    // The defaults are load-bearing (lease window vs heartbeat cadence); pin them.
    expect(DEFAULT_LEASE_MS).toBe(60_000);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(DEFAULT_LEASE_MS);
  });
});

// Run `fn` with console output captured into string arrays (restored after). The
// structured logger routes info → console.log and warn/error → console.error, so
// `logs` captures console.log and `warns` captures console.error (the warn sink).
function captureConsole<T>(fn: () => T): { logs: string[]; warns: string[]; value: T } {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => warns.push(a.join(" "));
  try {
    return { logs, warns, value: fn() };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function workerWithDefaultOnResult(): RunWorker {
  // Built only to reach its private default onResult; never started.
  return new RunWorker({
    pool: new WorkerPool().asPgPool(),
    jobQueue: new FakeJobQueue(),
    allocator: new RecordingAllocator(),
    ssh: new RecordingSsh(),
    secrets: new FakeSecretStore(),
    githubHttp: passingGitHub(),
    identitySecretRef: "runner/test/identity",
  });
}

function emitResult(worker: RunWorker, result: unknown): { logs: string[]; warns: string[] } {
  const onResult = (worker as unknown as { onResult: (r: unknown) => void }).onResult;
  return captureConsole(() => onResult(result));
}

// The default onResult routes completed/quota_denied/failed to distinct console
// channels; each test asserts the channel chosen + the message contents.
describe("RunWorker default onResult logging classifier", () => {
  const emit = emitResult;

  it("logs completed runs on console.log with the run id + outcome", () => {
    const out = emit(workerWithDefaultOnResult(), {
      kind: "completed",
      jobId: "job_9",
      runId: "run_9",
      outcome: "passed",
    });
    expect(out.logs.join("\n")).toContain("job_9");
    expect(out.logs.join("\n")).toContain("run_9");
    expect(out.logs.join("\n")).toContain("passed");
    expect(out.warns).toEqual([]);
  });

  it("warns failed runs with the failure kind + message", () => {
    const out = emit(workerWithDefaultOnResult(), {
      kind: "failed",
      jobId: "job_f",
      failure: { kind: "worker_infra_error", message: "db down" },
    });
    expect(out.warns.join("\n")).toContain("worker_infra_error");
    expect(out.warns.join("\n")).toContain("db down");
  });

  it("logs nothing for an idle poll", () => {
    const out = emit(workerWithDefaultOnResult(), { kind: "idle" });
    expect(out.logs).toEqual([]);
    expect(out.warns).toEqual([]);
  });
});

describe("RunWorker lifecycle (slots, concurrency, drain)", () => {
  it("backs off after a claim transport throw instead of hot-looping", async () => {
    const { pool, secrets } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    let claims = 0;
    const claimClient = {
      async claimJob() {
        claims += 1;
        throw new Error("getaddrinfo ENOTFOUND orchestrator");
      },
    };

    const results: ExecuteJobResult[] = [];
    const sleeps: number[] = [];
    const worker = new RunWorker(
      { ...deps(pool, secrets, jobQueue, passingGitHub()), claimClient },
      {
        concurrency: 1,
        pollIntervalMs: 250,
        sleep: (ms) => {
          sleeps.push(ms);
          return new Promise<void>(() => {});
        },
        onResult: (r) => results.push(r),
      },
    );
    worker.start();

    for (let i = 0; i < 20 && sleeps.length === 0; i += 1) {
      await delay(1);
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "failed",
      jobId: "<unclaimed>",
      failure: { kind: "worker_infra_error", message: "getaddrinfo ENOTFOUND orchestrator" },
    });
    expect(sleeps).toEqual([250]);
    expect(claims).toBe(1);

    await delay(5);
    expect(claims).toBe(1);

    await worker.stop();

    expect(claims).toBe(1);
    expect(worker.isDraining).toBe(true);
  });

  it("clamps concurrency to at least 1 and starts that many slots", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    // concurrency 0 → clamped to 1 (Math.max(1, ...)); the single slot still
    // claims + completes the one job.
    const results: string[] = [];
    const worker = new RunWorker(deps(pool, secrets, jobQueue, passingGitHub()), {
      concurrency: 0,
      pollIntervalMs: 5,
      onResult: (r) => {
        if (r.kind !== "idle") results.push(r.kind);
      },
    });
    worker.start();
    await delay(30);
    await worker.stop();

    expect(results).toContain("completed");
  });

  it("start() is idempotent — a second call does not double the slots", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    let completed = 0;
    const worker = new RunWorker(deps(pool, secrets, jobQueue, passingGitHub()), {
      concurrency: 1,
      pollIntervalMs: 5,
      onResult: (r) => {
        if (r.kind === "completed") completed += 1;
      },
    });
    worker.start();
    worker.start();
    await delay(30);
    await worker.stop();

    // Only one slot existed, so the single queued job is completed exactly once.
    expect(completed).toBe(1);
    expect(worker.isDraining).toBe(true);
  });
});
