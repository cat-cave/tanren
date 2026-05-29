/**
 * plannerRun.fixtures — shared fakes, scripted clients, and helper builders for
 * the runPlannerLoopWorkflow integration tests. Extracted from plannerRun.test.ts
 * to keep that file under the 500-line architecture cap.
 */
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import type { PlannerRunContext } from "../src/engine/workflow/plannerRun.js";
import {
  buildPlan,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
} from "./helpers/plannerLoopHelpers.js";

export {
  buildPlan,
  failingCheck,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";

export const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

export function context(): PlannerRunContext {
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
    githubCredentialRef: "credential/github/dev",
  };
}

export function healthyWindow(): WindowObservation {
  return {
    usage: {
      provider: "openai",
      windows: [
        {
          slot: "primary",
          usedPercent: 10,
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

export function exhaustedWindow(): WindowObservation {
  const slot = {
    slot: "secondary" as const,
    usedPercent: 100,
    resetsAt: "2026-05-30T00:00:00Z",
    windowMinutes: 10080,
    resetDescription: "May 30",
  };
  return {
    usage: {
      provider: "openai",
      windows: [slot],
      creditsRemaining: 0,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "x",
    },
    pressure: slot,
  };
}

export function accounting(costUsd: number | null): CcusageAccounting {
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
    costUsd,
    perModel: [],
    capturedAt: "2026-05-28T00:00:00Z",
  };
}

export function fakeProbe(window: WindowObservation, acct: CcusageAccounting | null): UsageProbe {
  return {
    async observeWindow() {
      return window;
    },
    async observeAccounting() {
      return acct;
    },
  };
}

export function twoSubtaskAdapters(checks: ReadonlyArray<CheckAnswer>) {
  return {
    planner: makePlanner([
      buildPlan([
        { title: "T1", intent: "add ok()", behaviorIds: [] },
        { title: "T2", intent: "add fail()", behaviorIds: [] },
      ]),
    ]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff ok\n", "diff fail\n"]),
    checker: makeChecker(checks) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>,
  };
}

export async function setup() {
  const ctx = context();
  const pool = new PlannerRunPool(ctx);
  const events = new FakeEventStore();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: ctx.githubCredentialRef, token: "ghp_secretToken" });
  const allocator = new RecordingAllocator();
  const ssh = new RecordingSsh();
  return { ctx, pool, events, secrets, allocator, ssh };
}

// P3-0008: inject an approving review probe + a no-op merge probe so the
// post-CI review→merge tail completes without hitting GitHub. The default
// project config in the test pool resolves mergeIntegration=not_configured →
// the merge stage hands off (no merge call), so the merge probe is never used.
export function approvingReview() {
  return {
    markReady: async () => undefined,
    fetchVerdict: async () => ({
      verdict: "approved" as const,
      latest: { state: "approved" as const, reviewer: "reviewer-bot" },
    }),
  };
}

export function noopMerge() {
  return {
    applyQueueLabel: async () => undefined,
    merge: async () => ({
      merged: true,
      mergeSha: "merge-sha",
      conflict: false,
      status: 200,
      message: "merged",
    }),
  };
}

export function passingGitHub(): ScriptedGitHubHttp {
  return new ScriptedGitHubHttp([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 7,
        html_url: "https://github.com/cat-cave/tanren-fixture-medium/pull/7",
        draft: true,
        base: { ref: "main" },
      },
    },
    { status: 200, body: { head: { sha: "a".repeat(40), ref: "tanren/planner-test" } } },
    {
      status: 200,
      body: {
        check_runs: [
          {
            name: "check",
            status: "completed",
            conclusion: "success",
            html_url: "https://ci.example/check",
          },
        ],
      },
    },
    { status: 200, body: { statuses: [] } },
  ]);
}

export class RecordingAllocator implements Allocator {
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

export class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

export class ScriptedGitHubHttp implements GitHubHttpClient {
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
export class PlannerRunPool {
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
      return {
        rows: this.costRows.map((row) => ({ id: row.id, total_tokens: row.total_tokens })),
        rowCount: this.costRows.length,
      };
    }
    if (trimmed.startsWith("UPDATE cost_records SET cost_usd")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costRows.push({ id: String(this.nextCostId++), total_tokens: Number(params[11] ?? 0) });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO tasks")) {
      this.taskKinds.push(String(trimmed.includes("'ci'") ? "ci" : (params[2] ?? "plan")));
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
            config: { githubCredentialRef: this.runContext.githubCredentialRef },
            // P3-0008 review/merge context columns (shares this SELECT prefix).
            default_branch: "main",
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith("SELECT task_id, attempt")) {
      return {
        rows: this.ciTask === undefined ? [] : [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }],
        rowCount: this.ciTask === undefined ? 0 : 1,
      };
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
