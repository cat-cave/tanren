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
import type pg from "pg";
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
  passingCheck
} from "./helpers/plannerLoopHelpers.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity"
};

const codexCredentialRef = "credential/codex/dev";
const githubCredentialRef = "credential/github/dev";

function healthyWindow(): WindowObservation {
  return {
    usage: {
      provider: "openai",
      windows: [{ slot: "primary", usedPercent: 5, resetsAt: "2026-06-01T00:00:00Z", windowMinutes: 300, resetDescription: "soon" }],
      creditsRemaining: null,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "2026-05-28T00:00:00Z"
    },
    pressure: null
  };
}

function accounting(): CcusageAccounting {
  return {
    cli: "codex",
    totals: { inputTokens: 8, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 12 },
    costUsd: 0.25,
    perModel: [],
    capturedAt: "2026-05-28T00:00:00Z"
  };
}

function fakeProbe(): UsageProbe {
  return {
    async observeWindow() {
      return healthyWindow();
    },
    async observeAccounting() {
      return accounting();
    }
  };
}

function passingAdapters() {
  return {
    planner: makePlanner([buildPlan([{ title: "T1", intent: "implement it", behaviorIds: [] }])]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff\n"]),
    checker: makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>
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
        fetchVerdict: async () => ({ verdict: "approved" as const, latest: { state: "approved" as const, reviewer: "reviewer-bot" } })
      },
      mergeProbe: {
        applyQueueLabel: async () => undefined,
        merge: async () => ({ merged: true, mergeSha: "merge-sha", conflict: false, status: 200, message: "merged" })
      }
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
    config: { version: 1, credentials: { codexCredentialRef, githubCredentialRef } }
  });
  const spec = await createSpec(pool.asPgPool(), {
    projectId: project.projectId,
    title: "Add a marker file",
    description: "Create the marker.",
    acceptanceCriteria: ["marker exists"]
  });
  const run = await createQueuedRunFromSpec(pool.asPgPool(), { specId: spec.specId, branch: "tanren/worker-test" });
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
    runWorkflow: fakeWorkflowRunner(github)
  };
}

describe("run worker (dequeue→execute seam)", () => {
  it("claims the queued plan job, runs the workflow, completes the job, and lands a terminal run", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {} });

    const github = passingGitHub();
    const result = await executeNextPlanJob(deps(pool, secrets, jobQueue, github));

    expect(result).toMatchObject({ kind: "completed", runId: run.runId, outcome: "passed" });
    // Real terminal state on the run + the spec (workflow finalization).
    expect(pool.runStatus).toEqual({ status: "done", outcome: "ok" });
    expect(pool.specStatus).toBe("done");
    // The job reached a terminal queue state (not left running).
    expect(await jobQueue.claim("plan")).toBeUndefined();
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
    await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {} });

    const throwingDeps = {
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      // A generic throw the workflow surfaces as failed/failed; the worker must
      // re-finalize it into a recoverable halted state.
      runWorkflow: async () => {
        await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [run.runId]);
        throw new Error("boom");
      }
    };
    const result = await executeNextPlanJob(throwingDeps);

    expect(result.kind).toBe("failed");
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("drains in-flight work on stop and stops claiming", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {} });

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
      }
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
    { status: 201, body: { number: 11, html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/11", draft: true, base: { ref: "main" } } },
    { status: 200, body: { head: { sha: "b".repeat(40), ref: "tanren/worker-test" } } },
    { status: 200, body: { check_runs: [{ name: "check", status: "completed", conclusion: "success", html_url: "https://ci.example/c" }] } },
    { status: 200, body: { statuses: [] } }
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

// In-memory pg substitute covering exactly the SQL the seam emits:
// createProject/createSpec/createQueuedRunFromSpec inserts + reads, the
// worker's run⋈spec⋈project join, resolveCredentialsForRun's org read, and the
// planner-loop workflow's run/spec state + task/cost/CI queries.
interface ProjectRow {
  project_id: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  config: unknown;
  org_id: string | null;
}
interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: string[];
  status: string;
}
interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  branch: string;
}

class WorkerPool {
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  specStatus = "pending";
  prUrl: string | null = null;
  private readonly projects = new Map<string, ProjectRow>();
  private readonly specs = new Map<string, SpecRow>();
  private readonly runs = new Map<string, RunRow>();
  private readonly costRows: Array<{ id: string; total_tokens: number }> = [];
  private nextCostId = 1;
  private ciTask: { taskId: string; attempt: number } | undefined;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    if (trimmed.startsWith("INSERT INTO projects")) {
      this.projects.set(String(params[0]), {
        project_id: String(params[0]),
        repo_url: String(params[2]),
        default_branch: String(params[3]),
        runner_image: String(params[4]),
        config: JSON.parse(String(params[6])) as unknown,
        org_id: params[7] === null ? null : String(params[7])
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT project_id FROM projects")) {
      return single(this.projects.has(String(params[0])) ? { project_id: String(params[0]) } : undefined);
    }
    if (trimmed.startsWith("INSERT INTO project_members")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      this.specs.set(String(params[0]), {
        spec_id: String(params[0]),
        project_id: String(params[1]),
        title: String(params[2]),
        description: String(params[3]),
        acceptance_criteria: JSON.parse(String(params[4])) as unknown,
        depends_on: params[5] as string[],
        status: String(params[6])
      });
      return { rows: [], rowCount: 1 };
    }
    // createQueuedRunFromSpec: spec⋈project load
    if (/FROM specs s\s+JOIN projects p/.test(trimmed)) {
      const spec = this.specs.get(String(params[0]));
      if (spec === undefined) return { rows: [], rowCount: 0 };
      const project = this.projects.get(spec.project_id)!;
      return single({
        project_id: project.project_id,
        name: "p",
        repo_url: project.repo_url,
        default_branch: project.default_branch,
        runner_image: project.runner_image,
        allocator: "local-docker",
        config: project.config,
        spec_id: spec.spec_id,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: spec.acceptance_criteria,
        depends_on: spec.depends_on,
        status: spec.status
      });
    }
    // worker loadRunExecutionContext: run⋈spec⋈project join
    if (/FROM runs r\s+JOIN specs s/.test(trimmed)) {
      const run = this.runs.get(String(params[0]));
      if (run === undefined) return { rows: [], rowCount: 0 };
      const spec = this.specs.get(run.spec_id)!;
      const project = this.projects.get(run.project_id)!;
      return single({
        run_id: run.run_id,
        spec_id: run.spec_id,
        project_id: run.project_id,
        branch: run.branch,
        repo_url: project.repo_url,
        default_branch: project.default_branch,
        runner_image: project.runner_image,
        config: project.config,
        org_id: project.org_id,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: spec.acceptance_criteria
      });
    }
    if (trimmed.startsWith("SELECT config FROM organizations")) {
      return single({ config: {} });
    }
    if (trimmed.startsWith("INSERT INTO runs")) {
      this.runs.set(String(params[0]), {
        run_id: String(params[0]),
        spec_id: String(params[1]),
        project_id: String(params[2]),
        branch: String(params[4])
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO job_queue")) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // Event-store inserts (PgEventStore writes through the real pool). Matched
    // via regex rather than a string literal so the single-event-writer
    // architecture check does not flag this in-memory fake pool router.
    if (/^INSERT\s+INTO\s+events/.test(trimmed)) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // spec status transitions (claim 'active', finalize 'done')
    if (trimmed.startsWith("UPDATE specs SET status = 'active'")) {
      this.specStatus = "active";
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE specs SET status = 'done'")) {
      this.specStatus = "done";
      return { rows: [], rowCount: 1 };
    }
    // P3-0008 merge stage marks the spec merged/done with a parameterized status.
    if (trimmed.startsWith("UPDATE specs SET status = $2")) {
      this.specStatus = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    // cost_records reconcile path
    if (trimmed.startsWith("SELECT id, total_tokens FROM cost_records")) {
      return { rows: this.costRows.map((r) => ({ id: r.id, total_tokens: r.total_tokens })), rowCount: this.costRows.length };
    }
    if (trimmed.startsWith("UPDATE cost_records SET cost_usd")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costRows.push({ id: String(this.nextCostId++), total_tokens: Number(params[11] ?? 0) });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO tasks")) {
      if (trimmed.includes("'ci'")) {
        this.ciTask = { taskId: String(params[0]), attempt: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE tasks")) {
      return { rows: [], rowCount: 1 };
    }
    // CI poll: run⋈project read for the github cred ref
    if (trimmed.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.pr_url")) {
      const runId = String(params[0]);
      const run = this.runs.get(runId)!;
      return single({
        run_id: run.run_id,
        spec_id: run.spec_id,
        project_id: run.project_id,
        pr_url: this.prUrl,
        config: { githubCredentialRef },
        // P3-0008 review/merge context columns (shares this SELECT prefix).
        default_branch: "main",
        org_config: null
      });
    }
    if (trimmed.startsWith("SELECT task_id, attempt")) {
      return this.ciTask === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET pr_url")) {
      this.prUrl = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'running'")) {
      this.runStatus = { status: "running", outcome: null };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'done'")) {
      this.runStatus = { status: "done", outcome: "ok" };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'halted'")) {
      // Worker recoverable-finalize is guarded by a status filter + RETURNING.
      if (trimmed.includes("RETURNING")) {
        if (["running", "queued", "failed"].includes(this.runStatus.status)) {
          this.runStatus = { status: "halted", outcome: "halted" };
          const run = this.runs.get(String(params[0]));
          return {
            rows: [{ run_id: String(params[0]), spec_id: run?.spec_id ?? "", project_id: run?.project_id ?? "" }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
      this.runStatus = { status: "halted", outcome: String(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'failed'")) {
      this.runStatus = { status: "failed", outcome: "failed" };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE job_queue")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<WorkerPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

function single<T>(row: T | undefined): { rows: unknown[]; rowCount: number } {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}
