// / plane-split P1: behavior tests for the run-worker lifecycle helpers
// in `lifecycle.ts` — `startRunWorker` (which takes the slot concurrency from
// the `concurrency` config input, NOT an env var — autonomy-engine.md §1.4) and
// the dep threading.
//
// Concurrency is observed through the number of slots the started worker runs:
// each slot, finding the queue empty, parks in the injected `sleep`. The PEAK
// number of slots parked in sleep at once equals the configured concurrency, so
// the config-driven `concurrency` input is asserted on an observable count — no
// real DB needed (the empty `PgJobQueue` claim returns idle immediately).

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { ClaimJobOptions, JobClaimClient } from "../src/engine/contracts/jobClaim.js";
import type { JobEnvelope } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
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
const noopSsh: CommandSubstrate = {
  async run() {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  },
};
const noopGitHub: GitHubHttpClient = {
  async request() {
    throw new Error("not used — the queue is always empty");
  },
};

function baseInput(pool: WorkerPool, concurrency: number) {
  return {
    pool: pool.asPgPool(),
    concurrency,
    allocator: noopAllocator,
    ssh: noopSsh,
    secrets: new FakeSecretStore(),
    vcsProvider: vcsProviderOver(noopGitHub),
    identitySecretRef: "runner/test/identity",
  };
}

/**
 * Start a worker via `startRunWorker` with a config-driven `concurrency`, count
 * the PEAK number of slots concurrently parked in the idle sleep, then drain. The
 * peak equals the slot count == the configured concurrency.
 */
async function peakSlotCount(concurrency: number): Promise<number> {
  const pool = new EmptyClaimPool();
  let live = 0;
  let peak = 0;
  const { worker, reaper } = startRunWorker({
    ...baseInput(pool, concurrency),
    // `options` is spread AFTER the config concurrency, so injecting sleep does
    // NOT override concurrency — exactly the seam we want to measure.
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
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  await Promise.all([worker.stop(), reaperStopped]);
  return peak;
}

describe("startRunWorker — concurrency from config (lifecycle.ts)", () => {
  it("starts exactly the configured number of slots", async () => {
    expect(await peakSlotCount(3)).toBe(3);
  });

  it("starts a single slot when configured to 1", async () => {
    expect(await peakSlotCount(1)).toBe(1);
  });

  it("scales to a higher configured ceiling", async () => {
    expect(await peakSlotCount(4)).toBe(4);
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

const codexCredentialRef = "credential/codex/dev";
const ORG = "org_lifecycle_test";

async function seedRunWithOrg(pool: WorkerPool) {
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(pool.asPgPool(), {
    name: "lifecycle-test",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    config: {
      version: 1,
      credentials: { defaultLlm: { cli: "codex", model: "default", authRef: codexCredentialRef }, githubCredentialRef },
    },
  });
  const spec = await createSpec(pool.asPgPool(), {
    projectId: project.projectId,
    title: "Add a marker file",
    description: "Create the marker.",
    acceptanceCriteria: ["marker exists"],
  });
  const run = await createQueuedRunFromSpec(pool.asPgPool(), { specId: spec.specId, branch: "tanren/lifecycle" });
  // Force the run's resolved org so the per-job org branches engage.
  pool.forcedProjectOrgId = ORG;
  return { secrets, run };
}

describe("startRunWorker — dep wiring (lifecycle.ts)", () => {
  it("threads the injected claimClient through to the executor", async () => {
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

    const results: ExecuteJobResult[] = [];
    const { worker, reaper } = startRunWorker({
      pool: pool.asPgPool(),
      concurrency: 1,
      allocator: noopAllocator,
      ssh: noopSsh,
      secrets,
      vcsProvider: vcsProviderOver(noopGitHub),
      identitySecretRef: "runner/test/identity",
      claimClient,
      options: { pollIntervalMs: 0, onResult: (r) => results.push(r) },
    });
    // Stop the co-located reaper in this tick (before its first pass resolves) so
    // its drain does not wait the default 30s inter-pass sleep.
    const reaperStopped = reaper.stop();
    // Wait for the one job to be claimed (via the injected client) + processed.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    await Promise.all([worker.stop(), reaperStopped]);

    // The injected claimClient was used (not the default direct DB-CAS): it was
    // asked to claim, and the one job it handed out drove a result.
    expect(claimClient.calls).toBeGreaterThan(0);
    expect(results.some((r) => r.kind === "completed" || r.kind === "failed")).toBe(true);
  });
});
