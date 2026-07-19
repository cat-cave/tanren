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
import { WorkerPool } from "./helpers/workerPool.js";

// An always-empty pool: every `PgJobQueue.claim` returns no row, so every slot
// goes straight to its idle `sleep` — letting us count the live slots.
class EmptyClaimPool extends WorkerPool {}

const noopAllocator: Allocator = {
  taxonomy: "fixed_pool" as const,
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
    githubHttp: noopGitHub,
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

const codexCredentialRef = "credential/codex/org/org_lifecycle_test/dev";
const ORG = "org_lifecycle_test";
const githubCredentialRef = "credential/github/org/org_lifecycle_test/dev";

async function seedRunWithOrg(pool: WorkerPool) {
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(
    pool.asPgPool(),
    {
      name: "lifecycle-test",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      defaultBranch: "main",
      config: {
        version: 1,
        credentials: {
          defaultLlm: { cli: "codex", model: "default", authRef: codexCredentialRef },
          githubCredentialRef,
        },
      },
    },
    {
      userId: "user_lifecycle_fixture",
      orgId: ORG,
      projectId: null,
      scopes: ["org:admin"],
      source: "session",
    },
  );
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
      orgId: ORG,
    });

    const results: ExecuteJobResult[] = [];
    const { worker, reaper } = startRunWorker({
      pool: pool.asPgPool(),
      concurrency: 1,
      allocator: noopAllocator,
      ssh: noopSsh,
      secrets,
      githubHttp: noopGitHub,
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

// gv-11 / #25 regression pins: the private-repo VISIBILITY predicate is AUTO-INVOKED
// by the sole production worker construction (`startRunWorker`, lifecycle.ts) — a
// caller cannot forget to wire it (the RunExecutorDeps field is required). These
// drive a REAL job all the way through `startRunWorker` and assert the outcome; no
// test here constructs or calls the admission — the gate/admission path does.
async function driveOneJobThroughStartRunWorker(
  pool: WorkerPool,
  secrets: FakeSecretStore,
  run: { runId: string; plannerTaskId: string },
): Promise<ExecuteJobResult[]> {
  const claimClient = new OneJobClaimClient({
    id: "job_visibility",
    runId: run.runId,
    taskId: run.plannerTaskId,
    taskKind: "plan",
    payload: {},
    attempts: 1,
    orgId: ORG,
  });
  const results: ExecuteJobResult[] = [];
  const { worker, reaper } = startRunWorker({
    pool: pool.asPgPool(),
    concurrency: 1,
    allocator: noopAllocator,
    ssh: noopSsh,
    secrets,
    githubHttp: noopGitHub,
    identitySecretRef: "runner/test/identity",
    claimClient,
    options: { pollIntervalMs: 0, onResult: (r) => results.push(r) },
  });
  const reaperStopped = reaper.stop();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
  await Promise.all([worker.stop(), reaperStopped]);
  return results;
}

describe("startRunWorker — repository-visibility admission is auto-invoked (gv-11 / #25)", () => {
  it("REFUSES a private-repo run when the Reviewer-App identity is not configured (fail-closed)", async () => {
    const pool = new WorkerPool();
    const { secrets, run } = await seedRunWithOrg(pool);
    // The project DECLARES a private repo, so the auto-wired admission must obtain a
    // fresh Reviewer-App readback. The org has no GitHub App installation configured
    // (org config carries no github_app), so the real `GithubReviewerAppIdentity`
    // fails closed (`ReviewerAppNotConfiguredError`) — a private repo can NOT be
    // admitted without the enforced Reviewer-App visibility check.
    pool.declaredRepoVisibility = "private";

    const results = await driveOneJobThroughStartRunWorker(pool, secrets, run);

    // The run was REFUSED at the admission gate — its terminal failure is the
    // Reviewer-App identity check (`ReviewerAppNotConfiguredError`), raised BEFORE
    // any workflow stage. The predicate was auto-invoked by the worker; nothing in
    // this test called `admit`. A private repo cannot be admitted without the
    // enforced Reviewer-App visibility check.
    const failed = results.find((r) => r.kind === "failed");
    if (failed === undefined || failed.kind !== "failed")
      throw new Error("expected the private-repo run to be refused");
    expect(failed.failure.kind).toBe("ReviewerAppNotConfiguredError");
    expect(failed.failure.message).toMatch(/Reviewer-App/u);
    expect(results.every((r) => r.kind !== "completed")).toBe(true);
  });

  it("does NOT block an undeclared-visibility run — the gate only enforces a declared repo", async () => {
    const pool = new WorkerPool();
    const { secrets, run } = await seedRunWithOrg(pool);
    // No declared visibility (the default): the admission skips the Reviewer-App
    // readback and the run proceeds PAST admission into the workflow. This proves the
    // fail-closed refusal above is caused by the visibility gate specifically, not a
    // generic admission short-circuit — an undeclared repo is never refused for
    // visibility. (The run still terminates for an unrelated reason in this noop-adapter
    // harness, but crucially NOT with the Reviewer-App visibility check.)
    pool.declaredRepoVisibility = null;

    const results = await driveOneJobThroughStartRunWorker(pool, secrets, run);

    const failed = results.find((r) => r.kind === "failed");
    if (failed === undefined || failed.kind !== "failed") throw new Error("expected the undeclared run to advance");
    // The run got PAST the visibility admission gate — its terminal failure is NOT
    // the Reviewer-App visibility check.
    expect(failed.failure.kind).not.toBe("ReviewerAppNotConfiguredError");
    expect(failed.failure.message).not.toMatch(/Reviewer-App/u);
  });
});
