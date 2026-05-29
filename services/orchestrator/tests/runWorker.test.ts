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

import { describe, expect, it } from "vitest";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import { executeNextPlanJob, RunWorker } from "../src/engine/worker/index.js";
import {
  buildPlan,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";
import { WorkerPool } from "./helpers/workerPool.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const codexCredentialRef = "credential/codex/dev";
const githubCredentialRef = "credential/github/dev";

function healthyWindow(): WindowObservation {
  return {
    usage: {
      provider: "openai",
      windows: [
        {
          slot: "primary",
          usedPercent: 5,
          resetsAt: "2026-06-01T00:00:00Z",
          windowMinutes: 300,
          resetDescription: "soon",
        },
      ],
      creditsRemaining: null,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "2026-05-28T00:00:00Z",
    },
    pressure: null,
  };
}

function accounting(): CcusageAccounting {
  return {
    cli: "codex",
    totals: {
      inputTokens: 8,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 12,
    },
    costUsd: 0.25,
    perModel: [],
    capturedAt: "2026-05-28T00:00:00Z",
  };
}

function fakeProbe(): UsageProbe {
  return {
    async observeWindow() {
      return healthyWindow();
    },
    async observeAccounting() {
      return accounting();
    },
  };
}

function passingAdapters() {
  return {
    planner: makePlanner([
      buildPlan([{ title: "T1", intent: "implement it", behaviorIds: [] }]),
    ]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff\n"]),
    checker: makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>,
  };
}

// The workflow runner the worker uses in tests: the REAL runPlannerLoopWorkflow
// with fake adapters / usage probe injected through its existing seams, so the
// dequeue→execute body is exercised end-to-end without real Codex/SSH/GitHub.
function fakeWorkflowRunner(github: GitHubHttpClient) {
  return (input: Parameters<typeof runPlannerLoopWorkflow>[0]) =>
    runPlannerLoopWorkflow({
      ...input,
      githubHttp: github,
      maxCiPolls: 1,
      ciPollDelayMs: 0,
      sleep: async () => undefined,
      buildAdapters: () => passingAdapters(),
      buildUsageProbe: () => fakeProbe(),
      // P3-0008 review→merge tail: approve the review and no-op the merge so the
      // dequeue→execute seam runs end-to-end without real GitHub review/merge.
      reviewProbe: {
        markReady: async () => undefined,
        fetchVerdict: async () => ({
          verdict: "approved" as const,
          latest: { state: "approved" as const, reviewer: "reviewer-bot" },
        }),
      },
      mergeProbe: {
        applyQueueLabel: async () => undefined,
        merge: async () => ({
          merged: true,
          mergeSha: "merge-sha",
          conflict: false,
          status: 200,
          message: "merged",
        }),
      },
    });
}

async function setupSeededRun() {
  const pool = new WorkerPool();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(pool.asPgPool(), {
    name: "worker-test",
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
  const run = await createQueuedRunFromSpec(pool.asPgPool(), {
    specId: spec.specId,
    branch: "tanren/worker-test",
  });
  return { pool, secrets, run };
}

function deps(pool: WorkerPool, secrets: FakeSecretStore, jobQueue: FakeJobQueue, github: GitHubHttpClient) {
  return {
    pool: pool.asPgPool(),
    jobQueue,
    allocator: new RecordingAllocator(),
    ssh: new RecordingSsh(),
    secrets,
    githubHttp: github,
    identitySecretRef: "runner/test/identity",
    runWorkflow: fakeWorkflowRunner(github),
  };
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
    expect(pool.runStatus).toEqual({ status: "done", outcome: "ok" });
    expect(pool.specStatus).toBe("done");
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
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return fakeWorkflowRunner(passingGitHub())(input);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await worker.stop();

    expect(worker.isDraining).toBe(true);
    expect(results).toContain("completed");
    expect(pool.runStatus.status).toBe("done");
  });
});

class RecordingAllocator implements Allocator {
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: "runner_worker", imageSha: "sha256:worker", target };
  }

  async release(): Promise<void> {}
}

class RecordingSsh implements SshSubstrate {
  async run(_target: SshTarget, _command: SshCommand): Promise<SshCommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

function passingGitHub(): ScriptedGitHubHttp {
  return new ScriptedGitHubHttp([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 11,
        html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/11",
        draft: true,
        base: { ref: "main" },
      },
    },
    { status: 200, body: { head: { sha: "b".repeat(40), ref: "tanren/worker-test" } } },
    {
      status: 200,
      body: {
        check_runs: [
          {
            name: "check",
            status: "completed",
            conclusion: "success",
            html_url: "https://ci.example/c",
          },
        ],
      },
    },
    { status: 200, body: { statuses: [] } },
  ]);
}

class ScriptedGitHubHttp implements GitHubHttpClient {
  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}
