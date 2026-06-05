// Shared run-worker test helpers: a fake planner-loop workflow runner (the REAL
// runPlannerLoopWorkflow with fake adapters / usage probe / review+merge probes
// injected through its existing seams), a seeded-run setup against the in-memory
// WorkerPool, the executor deps builder, and recording allocator/ssh/github
// fakes. Shared by runWorker.test.ts (the original dequeue→execute seam suite)
// and runExecutor.test.ts (the mutation-strengthening behavior suite) so both
// drive the SAME real workflow body without real Codex/SSH/GitHub.

import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../../src/engine/answerers/schemas/index.js";
import { vcsProviderOver } from "./vcsProvider.js";
import type {
  AllocationRequest,
  Allocator,
  RunnerAllocation,
  RunnerHandle,
} from "../../src/engine/contracts/allocator.js";
import type { FakeJobQueue } from "../../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import { storeGithubToken } from "../../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type {
  AnswererAdapter,
  CcusageAccounting,
  UsageProbe,
  WindowObservation,
} from "../../src/engine/usage/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../../src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../../src/engine/workflow/plannerRun.js";
import {
  buildPlan,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./plannerLoopHelpers.js";
import { WorkerPool } from "./workerPool.js";

// Resolve after `ms` without leaking an executor return (no-promise-executor-return).
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

export const codexCredentialRef = "credential/codex/dev";
export const githubCredentialRef = "credential/github/dev";

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
export function fakeWorkflowRunner(github: GitHubHttpClient) {
  return (input: Parameters<typeof runPlannerLoopWorkflow>[0]) =>
    runPlannerLoopWorkflow({
      ...input,
      vcsProvider: vcsProviderOver(github),
      maxCiPolls: 1,
      ciPollDelayMs: 0,
      sleep: async () => {},
      buildAdapters: () => passingAdapters(),
      buildUsageProbe: () => fakeProbe(),
      // P3-0008 review→merge tail: approve the review and no-op the merge so the
      // dequeue→execute seam runs end-to-end without real GitHub review/merge.
      reviewProbe: {
        markReady: async () => {},
        fetchVerdict: async () => ({
          verdict: "approved" as const,
          latest: { state: "approved" as const, reviewer: "reviewer-bot" },
        }),
      },
      mergeProbe: {
        merge: async () => ({
          merged: true,
          mergeSha: "merge-sha",
          conflict: false,
          status: 200,
          message: "merged",
        }),
        // P2a: branch reports clean → up-to-date enforcement is a no-op.
        readMergeability: async () => ({
          state: "clean" as const,
          behind: false,
          baseBranch: "main",
          headBranch: "tanren/run",
        }),
        updateBranch: async () => ({ outcome: "up_to_date" as const, message: "up to date" }),
        retargetBase: async () => {},
        deleteIntegrationBranch: async () => {},
      },
    });
}

export async function setupSeededRun() {
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

export function deps(pool: WorkerPool, secrets: FakeSecretStore, jobQueue: FakeJobQueue, github: GitHubHttpClient) {
  return {
    pool: pool.asPgPool(),
    jobQueue,
    allocator: new RecordingAllocator(),
    ssh: new RecordingSsh(),
    secrets,
    vcsProvider: vcsProviderOver(github),
    identitySecretRef: "runner/test/identity",
    runWorkflow: fakeWorkflowRunner(github),
  };
}

export class RecordingAllocator implements Allocator {
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: "runner_worker", imageSha: "sha256:worker", target };
  }

  async release(): Promise<void> {}
}

export class RecordingSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

export function passingGitHub(): ScriptedGitHubHttp {
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

export class ScriptedGitHubHttp implements GitHubHttpClient {
  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    // MERGE-SAFETY (self-identity): the authenticated clone resolves Tanren's
    // pushing identity via the static `GET /user`. Answered out-of-band so the
    // ordered PR/CI/merge response queue stays in lockstep.
    if (input.method === "GET" && (input.path === "/user" || input.path.startsWith("/user?"))) {
      return { status: 200, body: { login: "tanren[bot]", id: 424242 } };
    }
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}
