// Mutation-strengthening behavior suite for the run executor (runExecutor.ts) +
// the RunWorker slot loop (runWorker.ts). Drives REAL observable outcomes — DB
// rows via the in-memory WorkerPool, claimed jobs, emitted events, quota
// decisions — through the fake-adapter workflow body (./helpers/workerExec.ts).

import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { executeNextPlanJob, RunWorker } from "../src/engine/worker/index.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  establishJobOrgContext,
  JobOrgContextLostError,
} from "../src/engine/worker/runExecutor.js";
import type { AdmissionDecision, AdmissionRequest, QuotaPolicy, RunUsage } from "../src/engine/quota/index.js";
import {
  deps,
  fakeWorkflowRunner,
  passingGitHub,
  RecordingAllocator,
  RecordingSsh,
  setupSeededRun,
} from "./helpers/workerExec.js";
import { WorkerPool } from "./helpers/workerPool.js";

// A recording quota policy: returns a scripted admission decision and captures
// the accrued usage, so the gate + post-run accrual are asserted on values.
const DEFAULT_ADMISSION_DECISION: AdmissionDecision = { admit: true };

class RecordingQuotaPolicy implements QuotaPolicy {
  readonly admissionCalls: Array<{ orgId: string; requested: AdmissionRequest }> = [];
  readonly accrued: Array<{ orgId: string; usage: RunUsage }> = [];
  constructor(private readonly decision: AdmissionDecision = DEFAULT_ADMISSION_DECISION) {}

  async checkAdmission(orgId: string, requested: AdmissionRequest): Promise<AdmissionDecision> {
    this.admissionCalls.push({ orgId, requested });
    return this.decision;
  }

  async accrueUsage(orgId: string, usage: RunUsage): Promise<void> {
    this.accrued.push({ orgId, usage });
  }
}

const ORG = "org_worker_test";

async function enqueuePlanJob(jobQueue: FakeJobQueue, run: { runId: string; plannerTaskId: string }, orgId?: string) {
  await jobQueue.enqueue({
    runId: run.runId,
    taskId: run.plannerTaskId,
    taskKind: "plan",
    payload: {},
    ...(orgId === undefined ? {} : { orgId }),
  });
}

describe("run worker — org-scoped execution (runExecutor RLS seam)", () => {
  it("establishes the per-job org context, runs the workflow org-scoped, completes, and accrues real usage", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    // Project + claimed job share ORG → the org !== null branches engage
    // (establish context, org-scoped workflow pool, accrual). Seed a cost row.
    pool.forcedProjectOrgId = ORG;
    pool.seedCostRow(12);
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run, ORG);

    const quota = new RecordingQuotaPolicy({ admit: true });
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      quotaPolicy: quota,
    });

    expect(result).toMatchObject({ kind: "completed", runId: run.runId });
    expect(pool.runStatus).toEqual({ status: "done", outcome: "ok" });
    // Pre-flight admission was checked for the run's org (orgId !== null branch).
    expect(quota.admissionCalls).toEqual([{ orgId: ORG, requested: { runs: 1 } }]);
    // Post-run accrual fed the run's REAL cost_records totals to the policy: one
    // accrual, for the run's org, runs+1 with the summed tokens + dollar cost.
    expect(quota.accrued).toHaveLength(1);
    expect(quota.accrued[0]!.orgId).toBe(ORG);
    expect(quota.accrued[0]!.usage.runs).toBe(1);
    expect(quota.accrued[0]!.usage.tokens).toBeGreaterThanOrEqual(12);
    expect(quota.accrued[0]!.usage.costUsd).toBe(1.5);
  });

  it("does NOT check admission or accrue for a legacy/unscoped job (org_id NULL)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    // No forced org → org_id NULL, so every `orgId !== null` branch is skipped.
    pool.seedCostRow(99);
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const quota = new RecordingQuotaPolicy({ admit: true });
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      quotaPolicy: quota,
    });

    expect(result.kind).toBe("completed");
    expect(quota.admissionCalls).toEqual([]);
    expect(quota.accrued).toEqual([]);
  });

  it("denies the run pre-flight when quota is exceeded — finalizes quota_exceeded, completes the job, never runs the workflow", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    pool.forcedProjectOrgId = ORG;
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run, ORG);

    let workflowRan = false;
    const quota = new RecordingQuotaPolicy({ admit: false, reason: "monthly cap hit", windowKey: "2026-05" });
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      quotaPolicy: quota,
      runWorkflow: async (input) => {
        workflowRan = true;
        return fakeWorkflowRunner(passingGitHub())(input);
      },
    });

    expect(result).toEqual({ kind: "quota_denied", jobId: "job_1", runId: run.runId, reason: "monthly cap hit" });
    // The run is finalized recoverable as quota_exceeded (NOT halted/failed).
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "quota_exceeded" });
    expect(pool.eventTypes).toContain("run.quota_exceeded");
    // The job is COMPLETED (not failed) so it is not retried; the workflow never ran.
    expect(workflowRan).toBe(false);
    expect(await jobQueue.claim("plan")).toBeUndefined();
    // A denied run is never accrued.
    expect(quota.accrued).toEqual([]);
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
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
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

// Run `fn` with console.log/warn captured into string arrays (restored after).
function captureConsole<T>(fn: () => T): { logs: string[]; warns: string[]; value: T } {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  try {
    return { logs, warns, value: fn() };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
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

  it("warns quota_denied runs with the reason (distinct from failed)", () => {
    const out = emit(workerWithDefaultOnResult(), {
      kind: "quota_denied",
      jobId: "job_q",
      runId: "run_q",
      reason: "cap reached",
    });
    expect(out.warns.join("\n")).toContain("quota_exceeded");
    expect(out.warns.join("\n")).toContain("cap reached");
    expect(out.logs).toEqual([]);
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
  it("converts an infra throw on claim into a worker_infra_error result (slot survives)", async () => {
    const { pool, secrets } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    // claim throws once (DB blip), then returns idle so the slot can drain.
    let calls = 0;
    jobQueue.claim = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
    };

    const results: string[] = [];
    const worker = new RunWorker(deps(pool, secrets, jobQueue, passingGitHub()), {
      concurrency: 1,
      pollIntervalMs: 1,
      onResult: (r) => results.push(r.kind === "failed" ? `failed:${r.failure.kind}` : r.kind),
    });
    worker.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await worker.stop();

    // The infra throw became a worker_infra_error result and the slot kept polling.
    expect(results.some((r) => r === "failed:worker_infra_error")).toBe(true);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
    worker.start(); // no-op
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await worker.stop();

    // Only one slot existed, so the single queued job is completed exactly once.
    expect(completed).toBe(1);
    expect(worker.isDraining).toBe(true);
  });
});
