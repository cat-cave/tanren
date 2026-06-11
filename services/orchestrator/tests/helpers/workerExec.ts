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
import { provisionedGreenfieldProjectConfigProof } from "../../src/engine/workflow/projectConfigWriteGuards.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type {
  AnswererAdapter,
  CcusageAccounting,
  UsageProbe,
  WindowObservation,
} from "../../src/engine/usage/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../../src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../../src/engine/workflow/plannerRun.js";
import { InMemoryCodeHost } from "../conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle } from "../../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceProgress,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makePlanner,
  makeTriage,
  makeWriter,
  triageAllTasks,
} from "./plannerLoopHelpers.js";
import { WorkerPool } from "./workerPool.js";

function directMergeConfig(): Record<string, unknown> {
  return {
    version: 1,
    mergeIntegration: "direct_merge",
    governancePosture: "open",
    credentials: { githubCredentialRef },
  };
}

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
    failure: null,
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
      return { ok: accounting() };
    },
  };
}

function passingAdapters() {
  return {
    planner: makePlanner([
      buildPlan([{ title: "T1", intent: "implement it", behaviorIds: [] }]),
    ]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff\n"]),
    checker: makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>,
    triage: makeTriage([triageAllTasks]),
    convergence: makeConvergence([convergenceProgress]),
    demoRun: makeDemoRun([{ findings: [], summary: "ok" }]),
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
      // review→merge tail: approve the review and no-op the merge so the
      // dequeue→execute seam runs end-to-end without real GitHub review/merge.
      reviewProbe: {
        markReady: async () => {},
        fetchVerdict: async () => ({
          verdict: "approved" as const,
          latest: { state: "approved" as const, reviewer: "reviewer-bot" },
        }),
      },
      mergeProbe: {
        // branch reports clean → up-to-date enforcement is a no-op.
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
      // The land is the unconditional `MergeAuthority` + CodeHost ff-only CAS (no host
      // PR-merge). Seed the in-memory host for the worker run's repo/PR head so the
      // dequeue→execute seam lands end-to-end without real GitHub.
      mergeAuthority: workerAuthorityBundle(),
    });
}

const WORKER_AUTHORITY_REPO = { owner: "cat-cave", name: "tanren-fixture-easy" };
const WORKER_AUTHORITY_HEAD_SHA = "sha-head";

/** The clean-clearing authority bundle for the worker run's land (repo + PR head seeded). */
function workerAuthorityBundle(): MergeAuthorityBundle {
  const host = new InMemoryCodeHost();
  host.seed(WORKER_AUTHORITY_REPO, "main", "sha-main");
  void host.pushRef({
    repo: WORKER_AUTHORITY_REPO,
    localRef: "feat",
    remoteBranch: "tanren/run",
    sha: WORKER_AUTHORITY_HEAD_SHA,
  });
  return {
    codeHost: host,
    orgId: "org_worker",
    finalizerFor: () => ({ finalizeLanded: async () => ({ auditId: "audit_1" }) }),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome: { passed: true, results: [] },
    gatedHeadSha: WORKER_AUTHORITY_HEAD_SHA,
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
    reviewVerdict: "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
  };
}

export async function setupSeededRun() {
  const pool = new WorkerPool();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(
    pool.asPgPool(),
    {
      name: "worker-test",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      defaultBranch: "main",
      config: {
        ...directMergeConfig(),
        credentials: {
          defaultLlm: { cli: "codex", model: "default", authRef: codexCredentialRef },
          githubCredentialRef,
        },
      },
    },
    undefined,
    { configWriteProof: provisionedGreenfieldProjectConfigProof },
  );
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
  // Every plan run is a TENANT run (runs.org_id is NOT NULL). The worker now
  // FAILS CLOSED on a null-org plan job, so the seeded run carries a concrete org:
  // the pool reports it for the project/run, and `seededOrgId` is the org the
  // enqueue stamps + the worker scopes to. (Tests that need a different org override
  // `pool.forcedProjectOrgId`.)
  pool.forcedProjectOrgId = SEEDED_ORG_ID;
  return { pool, secrets, run, orgId: SEEDED_ORG_ID };
}

/** The org the seeded worker run belongs to (a plan run always carries an org). */
export const SEEDED_ORG_ID = "org_worker_seed";

/**
 * Enqueue the seeded run's plan job carrying its org (the queue row's org_id the
 * worker scopes execution to). A plan job ALWAYS carries an org — the worker fails
 * closed otherwise — so this is the canonical enqueue helper the worker suites share.
 */
export async function enqueuePlanJob(
  jobQueue: FakeJobQueue,
  run: { runId: string; plannerTaskId: string },
  orgId: string = SEEDED_ORG_ID,
): Promise<void> {
  await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {}, orgId });
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
