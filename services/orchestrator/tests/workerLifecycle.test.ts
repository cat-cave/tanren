// P3-0001 / plane-split P1: behavior tests for the run-worker lifecycle helpers
// in `lifecycle.ts` — `startRunWorker` (which derives the slot concurrency from
// TANREN_RUN_WORKER_CONCURRENCY) and the env flag gate.
//
// Concurrency is observed through the number of slots the started worker runs:
// each slot, finding the queue empty, parks in the injected `sleep`. The PEAK
// number of slots parked in sleep at once equals the configured concurrency, so
// the env-parse (`workerConcurrencyFromEnv`) is asserted on an observable count
// — no real DB needed (the empty `PgJobQueue` claim returns idle immediately).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { ClaimJobOptions, JobClaimClient } from "../src/engine/contracts/jobClaim.js";
import type { JobEnvelope } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import type { AdmissionDecision, AdmissionRequest, QuotaPolicy, RunUsage } from "../src/engine/quota/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { startRunWorker } from "../src/engine/worker/index.js";
import type { ExecuteJobResult } from "../src/engine/worker/runExecutor.js";
import { githubCredentialRef, WorkerPool } from "./helpers/workerPool.js";

// An always-empty pool: every `PgJobQueue.claim` returns no row, so every slot
// goes straight to its idle `sleep` — letting us count the live slots.
class EmptyClaimPool extends WorkerPool {}

const noopAllocator: Allocator = {
  async allocate() {
    throw new Error("not used — the queue is always empty");
  },
  async release() {},
};
const noopSsh: SshSubstrate = {
  async run() {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  },
};
const noopGitHub: GitHubHttpClient = {
  async request() {
    throw new Error("not used — the queue is always empty");
  },
};

function baseInput(pool: WorkerPool) {
  return {
    pool: pool.asPgPool(),
    allocator: noopAllocator,
    ssh: noopSsh,
    secrets: new FakeSecretStore(),
    githubHttp: noopGitHub,
    identitySecretRef: "runner/test/identity",
  };
}

/**
 * Start a worker via `startRunWorker` (so the env-derived concurrency is used),
 * count the PEAK number of slots concurrently parked in the idle sleep, then
 * drain. The peak equals the slot count == the configured concurrency.
 */
async function peakSlotCount(): Promise<number> {
  const pool = new EmptyClaimPool();
  let live = 0;
  let peak = 0;
  const { worker, reaper } = startRunWorker({
    ...baseInput(pool),
    // `options` is spread AFTER the env-derived concurrency, so injecting sleep
    // does NOT override concurrency — exactly the seam we want to measure.
    options: {
      pollIntervalMs: 0,
      sleep: () =>
        new Promise<void>((resolve) => {
          live += 1;
          peak = Math.max(peak, live);
          // Resolve on the next tick so the slot loops back, re-claims (idle),
          // and parks again — keeping all slots alive concurrently.
          setTimeout(() => {
            live -= 1;
            resolve();
          }, 1);
        }),
    },
  });
  // Stop the co-located reaper in THIS tick (before its first pass resolves) so
  // its drain does not wait out the default 30s inter-pass sleep — we only care
  // about the worker's slots here.
  const reaperStopped = reaper.stop();
  // Let the slots spin up and reach their first concurrent park.
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  await Promise.all([worker.stop(), reaperStopped]);
  return peak;
}

describe("startRunWorker — concurrency from env (lifecycle.ts)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["TANREN_RUN_WORKER_CONCURRENCY"];

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("defaults to 2 slots when TANREN_RUN_WORKER_CONCURRENCY is unset", async () => {
    delete process.env["TANREN_RUN_WORKER_CONCURRENCY"];
    expect(await peakSlotCount()).toBe(2);
  });

  it("defaults to 2 slots when the env value is the empty string", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "";
    expect(await peakSlotCount()).toBe(2);
  });

  it("uses the configured slot count when set to a valid integer", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "4";
    expect(await peakSlotCount()).toBe(4);
  });

  it("floors a fractional value to the integer slot count", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "3.9";
    expect(await peakSlotCount()).toBe(3);
  });

  it("falls back to 2 slots for a non-numeric value", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "lots";
    expect(await peakSlotCount()).toBe(2);
  });

  it("falls back to 2 slots for a value below 1", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "0";
    expect(await peakSlotCount()).toBe(2);
  });
});

// A claim client that hands out one queued job (carrying an org) then idles, and
// records that it was asked to claim — so we can prove `startRunWorker` threaded
// the injected client through to the executor (rather than the default direct CAS).
class OneJobClaimClient implements JobClaimClient {
  calls = 0;
  constructor(private readonly job: JobEnvelope) {}
  async claimJob(_options: ClaimJobOptions): Promise<JobEnvelope | undefined> {
    this.calls += 1;
    if (this.calls === 1) {
      return this.job;
    }
    return undefined;
  }
}

class DenyingQuotaPolicy implements QuotaPolicy {
  admissionCalls = 0;
  constructor(private readonly reason: string) {}
  async checkAdmission(_orgId: string, _requested: AdmissionRequest): Promise<AdmissionDecision> {
    this.admissionCalls += 1;
    return { admit: false, reason: this.reason };
  }
  async accrueUsage(_orgId: string, _usage: RunUsage): Promise<void> {}
}

const codexCredentialRef = "credential/codex/dev";
const ORG = "org_lifecycle_test";

async function seedRunWithOrg(pool: WorkerPool) {
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(pool.asPgPool(), {
    name: "lifecycle-test",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    config: { version: 1, credentials: { codexCredentialRef, githubCredentialRef } },
  });
  const spec = await createSpec(pool.asPgPool(), {
    projectId: project.projectId,
    title: "Add a marker file",
    description: "Create the marker.",
    acceptanceCriteria: ["marker exists"],
  });
  const run = await createQueuedRunFromSpec(pool.asPgPool(), { specId: spec.specId, branch: "tanren/lifecycle" });
  // Force the run's resolved org so the per-job org branches engage; the quota
  // gate then runs and (denying) finalizes the run BEFORE any workflow/SSH work.
  pool.forcedProjectOrgId = ORG;
  return { secrets, run };
}

describe("startRunWorker — dep wiring (lifecycle.ts)", () => {
  const saved = process.env["TANREN_RUN_WORKER_CONCURRENCY"];
  beforeEach(() => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["TANREN_RUN_WORKER_CONCURRENCY"];
    } else {
      process.env["TANREN_RUN_WORKER_CONCURRENCY"] = saved;
    }
  });

  it("threads the injected claimClient AND quotaPolicy through to the executor", async () => {
    const pool = new WorkerPool();
    const { secrets, run } = await seedRunWithOrg(pool);
    const claimClient = new OneJobClaimClient({
      id: "job_life",
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      orgId: ORG,
    });
    const quota = new DenyingQuotaPolicy("cap reached");

    const results: ExecuteJobResult[] = [];
    const { worker, reaper } = startRunWorker({
      pool: pool.asPgPool(),
      allocator: noopAllocator,
      ssh: noopSsh,
      secrets,
      githubHttp: noopGitHub,
      identitySecretRef: "runner/test/identity",
      claimClient,
      quotaPolicy: quota,
      options: { pollIntervalMs: 0, onResult: (r) => results.push(r) },
    });
    // Stop the co-located reaper in this tick (before its first pass resolves) so
    // its drain does not wait the default 30s inter-pass sleep.
    const reaperStopped = reaper.stop();
    // Wait for the one job to be claimed (via the injected client) + denied.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await Promise.all([worker.stop(), reaperStopped]);

    // The injected claimClient was used (not the default direct DB-CAS).
    expect(claimClient.calls).toBeGreaterThan(0);
    // The injected quotaPolicy's pre-flight gate ran for the run's org.
    expect(quota.admissionCalls).toBe(1);
    // The denied run is finalized quota_exceeded (proving the policy decision
    // drove the outcome — the workflow / SSH never ran).
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "quota_exceeded" });
    expect(results.some((r) => r.kind === "quota_denied")).toBe(true);
  });
});
