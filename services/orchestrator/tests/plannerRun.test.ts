// P2A-0015: runPlannerLoopWorkflow integration tests. The workflow is driven
// with fake adapters + a fake usage probe (so no real SSH/Codex), asserting on
// the persisted run state, the PR/CI tail on a passing loop, the halted
// mapping for non-pass outcomes, and the CodexUsageLimitError → window
// escalation path. Allocator release always runs (finally).
import { describe, expect, it } from "vitest";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { runPlannerLoopWorkflow, type PlannerRunContext } from "../src/engine/workflow/plannerRun.js";
import { WorkspaceBootstrapError } from "../src/engine/workspace/index.js";
import {
  buildPlan,
  failingCheck,
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

function context(): PlannerRunContext {
  return {
    runId: "run_planner_test",
    specId: "spec_planner_test",
    projectId: "project_planner_test",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-medium",
    targetBranch: "main",
    runBranch: "tanren/planner-test",
    specTitle: "Add status helpers",
    specDescription: "Implement two small helpers across two subtasks.",
    acceptanceCriteria: ["status.ts exports ok()", "status.ts exports fail()"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev"
  };
}

function healthyWindow(): WindowObservation {
  return {
    usage: {
      provider: "openai",
      windows: [{ slot: "primary", usedPercent: 10, resetsAt: "2026-06-01T00:00:00Z", windowMinutes: 300, resetDescription: "soon" }],
      creditsRemaining: null,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "2026-05-28T00:00:00Z"
    },
    pressure: null
  };
}

function exhaustedWindow(): WindowObservation {
  const slot = { slot: "secondary" as const, usedPercent: 100, resetsAt: "2026-05-30T00:00:00Z", windowMinutes: 10080, resetDescription: "May 30" };
  return { usage: { provider: "openai", windows: [slot], creditsRemaining: 0, accountEmail: null, source: "codex-cli", capturedAt: "x" }, pressure: slot };
}

function accounting(costUsd: number | null): CcusageAccounting {
  return {
    cli: "codex",
    totals: { inputTokens: 8, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 12 },
    costUsd,
    perModel: [],
    capturedAt: "2026-05-28T00:00:00Z"
  };
}

function fakeProbe(window: WindowObservation, acct: CcusageAccounting | null): UsageProbe {
  return {
    async observeWindow() {
      return window;
    },
    async observeAccounting() {
      return acct;
    }
  };
}

function twoSubtaskAdapters(checks: ReadonlyArray<CheckAnswer>) {
  return {
    planner: makePlanner([
      buildPlan([
        { title: "T1", intent: "add ok()", behaviorIds: [] },
        { title: "T2", intent: "add fail()", behaviorIds: [] }
      ])
    ]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff ok\n", "diff fail\n"]),
    checker: makeChecker(checks) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>
  };
}

async function setup() {
  const ctx = context();
  const pool = new PlannerRunPool(ctx);
  const events = new FakeEventStore();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: ctx.githubCredentialRef, token: "ghp_secretToken" });
  const allocator = new RecordingAllocator();
  const ssh = new RecordingSsh();
  return { ctx, pool, events, secrets, allocator, ssh };
}

function passingGitHub(): ScriptedGitHubHttp {
  return new ScriptedGitHubHttp([
    { status: 200, body: [] },
    { status: 201, body: { number: 7, html_url: "https://github.com/cat-cave/tanren-fixture-medium/pull/7", draft: true, base: { ref: "main" } } },
    { status: 200, body: { head: { sha: "a".repeat(40), ref: "tanren/planner-test" } } },
    { status: 200, body: { check_runs: [{ name: "check", status: "completed", conclusion: "success", html_url: "https://ci.example/check" }] } },
    { status: 200, body: { statuses: [] } }
  ]);
}

describe("runPlannerLoopWorkflow", () => {
  it("drives the loop, publishes a PR, polls CI, and records a passing run on the happy path", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const github = passingGitHub();

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => undefined,
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5))
    });

    expect(result.outcome.kind).toBe("passed");
    expect(result.pullRequest?.prNumber).toBe(7);
    expect(result.ci?.status).toBe("passed");
    expect(pool.runStatus).toEqual({ status: "done", outcome: "ok" });
    expect(allocator.releases).toEqual(["runner_planner"]);

    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("runner.allocated");
    expect(names).toContain("workspace.prepared");
    expect(names).toContain("usage.window.observed");
    expect(names).toContain("usage.accounting.observed");
    expect(names).toContain("runner.released");
    expect(ssh.commands[0]?.command.command).toContain("git clone --depth 1");
    // Two subtasks → two write tasks persisted.
    expect(pool.taskKinds.filter((kind) => kind === "write")).toHaveLength(2);
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
  });

  it("re-plans on a checker rejection and still completes (medium-tier loop shape)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const adapters = {
      planner: makePlanner([
        buildPlan([
          { title: "T1", intent: "ok", behaviorIds: [] },
          { title: "T2", intent: "fail", behaviorIds: [] }
        ]),
        buildPlan([
          { title: "T1b", intent: "ok again", behaviorIds: [] },
          { title: "T2b", intent: "fail again", behaviorIds: [] }
        ])
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d1\n", "d2\n", "d3\n", "d4\n"]),
      checker: makeChecker([failingCheck, passingCheck, passingCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>
    };

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => undefined,
      buildAdapters: () => adapters,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null))
    });

    expect(result.outcome.kind).toBe("passed");
    expect(events.events.filter((event) => event.eventType === "planner.rerequested")).toHaveLength(1);
    expect(pool.runStatus.outcome).toBe("ok");
  });

  it("halts on window pressure without publishing a PR", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const github = new ScriptedGitHubHttp([]); // any request would throw

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(exhaustedWindow(), accounting(null))
    });

    expect(result.outcome.kind).toBe("window_exhausted");
    expect(result.pullRequest).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "window_exhausted" });
    expect(github.requests).toHaveLength(0);
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("bootstraps the workspace after clone and before the writer loop on the happy path", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const bootstrapCalls: string[] = [];

    await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => undefined,
      bootstrapCommand: "pnpm install --frozen-lockfile",
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command ?? "<default>");
      },
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5))
    });

    expect(bootstrapCalls).toEqual(["pnpm install --frozen-lockfile"]);
    const names = events.events.map((event) => event.eventType);
    expect(names.indexOf("workspace.prepared")).toBeLessThan(names.indexOf("writer.subtask.started"));
  });

  it("halts on a workspace bootstrap failure and surfaces it as a recoverable run", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();

    await expect(
      runPlannerLoopWorkflow({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context: ctx,
        escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
        timeoutMs: 100,
        runBootstrap: async (input) => {
          throw new WorkspaceBootstrapError(input.workspacePath, "pnpm install", 1, "vitest: not found", false);
        },
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null))
      })
    ).rejects.toBeInstanceOf(WorkspaceBootstrapError);

    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    const failure = events.events.find((event) => event.eventType === "workspace.failed");
    expect(failure?.payload).toMatchObject({ message: expect.stringContaining("vitest: not found") });
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("maps a Codex usage-limit thrown mid-loop to a halted window_exhausted run", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const throwingPlanner: AnswererAdapter<PlanAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/dev",
      async runAnswerer() {
        throw new CodexUsageLimitError("tanren.plan_answer.v1", "You've hit your usage limit.");
      }
    };

    await expect(
      runPlannerLoopWorkflow({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context: ctx,
        escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
        timeoutMs: 100,
        buildAdapters: () => ({
          planner: throwingPlanner,
          writer: makeWriter(["d\n"]),
          checker: makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>,
          auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>
        }),
        buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null))
      })
    ).rejects.toBeInstanceOf(CodexUsageLimitError);

    expect(pool.runStatus).toEqual({ status: "halted", outcome: "window_exhausted" });
    expect(allocator.releases).toEqual(["runner_planner"]);
  });
});

class RecordingAllocator implements Allocator {
  readonly requests: AllocationRequest[] = [];
  readonly releases: string[] = [];

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.requests.push(request);
    return { runnerId: "runner_planner", imageSha: "sha256:planner", target };
  }

  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

// Fake pool covering: run-state updates, the loop's task/cost rows (incl. the
// ccusage reconcile SELECT/UPDATE), the planner-task supersede, and the CI
// poll queries.
class PlannerRunPool {
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  prUrl: string | null = null;
  readonly taskKinds: string[] = [];
  private readonly costRows: Array<{ id: string; total_tokens: number }> = [];
  private nextCostId = 1;
  private ciTask: { taskId: string; attempt: number } | undefined;

  constructor(private readonly runContext: PlannerRunContext) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT id, total_tokens FROM cost_records")) {
      return { rows: this.costRows.map((row) => ({ id: row.id, total_tokens: row.total_tokens })), rowCount: this.costRows.length };
    }
    if (trimmed.startsWith("UPDATE cost_records SET cost_usd")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costRows.push({ id: String(this.nextCostId++), total_tokens: Number(params[11] ?? 0) });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO tasks")) {
      this.taskKinds.push(String(trimmed.includes("'ci'") ? "ci" : params[2] ?? "plan"));
      if (trimmed.includes("'ci'")) {
        this.ciTask = { taskId: String(params[0]), attempt: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.pr_url")) {
      return {
        rows: [
          {
            run_id: this.runContext.runId,
            spec_id: this.runContext.specId,
            project_id: this.runContext.projectId,
            pr_url: this.prUrl,
            config: { githubCredentialRef: this.runContext.githubCredentialRef }
          }
        ],
        rowCount: 1
      };
    }
    if (trimmed.startsWith("SELECT task_id, attempt")) {
      return { rows: this.ciTask === undefined ? [] : [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }], rowCount: this.ciTask === undefined ? 0 : 1 };
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
      this.runStatus = { status: "halted", outcome: String(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'failed'")) {
      this.runStatus = { status: "failed", outcome: "failed" };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  asPgPool() {
    return this as never;
  }
}
