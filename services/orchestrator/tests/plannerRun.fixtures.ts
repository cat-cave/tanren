/**
 * plannerRun.fixtures — shared fakes, scripted clients, and helper builders for
 * the runPlannerLoopWorkflow integration tests. Extracted from plannerRun.test.ts
 * to keep that file under the 500-line architecture cap.
 */
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type {
  AllocationRequest,
  Allocator,
  RunnerAllocation,
  RunnerHandle,
} from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { runWithSystemJobScope } from "@tanren/db";
import {
  runPlannerLoopWorkflow,
  type PlannerRunContext,
  type PlannerRunResult,
  type RunPlannerLoopInput,
} from "../src/engine/workflow/plannerRun.js";
import {
  buildPlan,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
} from "./helpers/plannerLoopHelpers.js";

/**
 * Run the planner-loop workflow under the EXPLICIT per-job SYSTEM scope, mirroring
 * production (the run worker wraps the workflow in `runWithSystemJobScope`). Without
 * it the tenant write resolves with no ambient scope and the hardened seam correctly
 * throws `MissingOrgScopeError`.
 */
export function runPlannerLoopScoped(input: RunPlannerLoopInput): Promise<PlannerRunResult> {
  return runWithSystemJobScope(() => runPlannerLoopWorkflow(input));
}

export {
  buildPlan,
  failingCheck,
  loopAudit,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";

export const target: RunnerHandle = {
  backend: "ssh",
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

export async function setup(projectConfig?: Record<string, unknown>) {
  const ctx = context();
  const pool = new PlannerRunPool(ctx, projectConfig);
  const events = new FakeEventStore();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: ctx.githubCredentialRef, token: "ghp_secretToken" });
  const allocator = new RecordingAllocator();
  const ssh = new RecordingSsh();
  return { ctx, pool, events, secrets, allocator, ssh };
}

// Project config that routes the merge stage down the direct-merge branch with
// an open governance posture (so the posture gate proceeds without a contributor
// lookup). The merge probe then decides merged / conflict / failed.
export function directMergeConfig(): Record<string, unknown> {
  return {
    // version:1 is mandatory — migrateProjectConfig fails hard on an unversioned
    // config. Strict schema, so the static credential ref lives under `credentials`.
    version: 1,
    mergeIntegration: "direct_merge",
    governancePosture: "open",
    credentials: { githubCredentialRef: "credential/github/dev" },
  };
}

// A review probe that returns changes_requested with a written body, then
// approved on the next poll — used to drive the review-rework re-entry.
export function changesThenApproveReview() {
  let calls = 0;
  return {
    markReady: async () => {},
    fetchVerdict: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          verdict: "changes_requested" as const,
          latest: { state: "changes_requested" as const, reviewer: "reviewer-bot", body: "please rename ok()" },
        };
      }
      return { verdict: "approved" as const, latest: { state: "approved" as const, reviewer: "reviewer-bot" } };
    },
  };
}

// A review probe that always returns changes_requested (with feedback), used to
// drive the rework-budget-exhausted halt.
export function alwaysChangesReview() {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({
      verdict: "changes_requested" as const,
      latest: { state: "changes_requested" as const, reviewer: "reviewer-bot", body: "still wrong" },
    }),
  };
}

// A review probe whose verdict never resolves (stays pending) — drives the
// pending-after-budget halt branch.
export function pendingReview() {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({ verdict: "pending" as const }),
  };
}

// P2a: the merge stage reads branch freshness before merging. These tail fixtures
// exercise the merge OUTCOME mapping, so they report the branch CLEAN + up to date
// (the enforcement is a no-op; the merge() outcome drives the result, as pre-P2a).
function cleanFreshness() {
  return {
    readMergeability: async () => ({
      state: "clean" as const,
      behind: false,
      baseBranch: "main",
      headBranch: "tanren/run_1",
    }),
    updateBranch: async () => ({ outcome: "up_to_date" as const, message: "up to date" }),
    // P2c-1: non-speculative fixtures never re-target/clean (no speculative_base),
    // but the probe must satisfy the full MergeProbe contract.
    retargetBase: async () => {},
    deleteIntegrationBranch: async () => {},
  };
}

// Direct-merge probe whose merge() reports a GitHub-detected conflict (405/409).
export function conflictMerge() {
  return {
    merge: async () => ({ merged: false, conflict: true, status: 409, message: "merge conflict" }),
    ...cleanFreshness(),
  };
}

// Direct-merge probe whose merge() neither merges nor conflicts → failed.
export function failedMerge() {
  return {
    merge: async () => ({ merged: false, conflict: false, status: 500, message: "merge api error" }),
    ...cleanFreshness(),
  };
}

// Direct-merge probe whose merge() succeeds.
export function mergedMerge() {
  return {
    merge: async () => ({ merged: true, mergeSha: "merge-sha", conflict: false, status: 200, message: "merged" }),
    ...cleanFreshness(),
  };
}

// P3-0008: inject an approving review probe + a no-op merge probe so the post-CI
// review→merge tail completes without hitting GitHub. The default test-pool config
// resolves mergeIntegration=not_configured → the merge stage hands off (no merge call).
export function approvingReview() {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({
      verdict: "approved" as const,
      latest: { state: "approved" as const, reviewer: "reviewer-bot" },
    }),
  };
}

export function noopMerge() {
  return {
    merge: async () => ({
      merged: true,
      mergeSha: "merge-sha",
      conflict: false,
      status: 200,
      message: "merged",
    }),
    ...cleanFreshness(),
  };
}

// The forge calls of a passing native run: PR-list + create, then the `tanren/gate`
// verdict-PUBLISH (a check-run, 201 → { id, html_url }). NATIVE delivery runs the merge
// gate over the command substrate (no forge poll); the publish 201 is consumed only when
// the SSH fake yields a real head sha (skipped, harmless, on a no-head-sha fake path).
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
    { status: 201, body: { id: 9001, html_url: "https://github.com/cat-cave/tanren-fixture-medium/runs/9001" } },
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

// A RecordingAllocator whose `release` THROWS — drives the security-baseline
// cleanup-proof's FAILED-teardown branch (the run records `release.finalized` with
// `cleanedUp: false` + the residual runner, without masking the run's own outcome).
export class FailingReleaseAllocator extends RecordingAllocator {
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
    throw new Error("hetzner: deleteServer 500\nsecond line should be dropped");
  }
}

export class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];
  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

export class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    // MERGE-SAFETY (self-identity): the clone's `GET /user` identity read, answered out-of-band.
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

// Fake pool covering: run-state updates, the loop's task/cost rows (incl. the
// ccusage reconcile SELECT/UPDATE), the planner-task supersede, and the CI
// poll queries.
export class PlannerRunPool {
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  prUrl: string | null = null;
  readonly taskKinds: string[] = [];
  // Every `UPDATE specs SET status = ...` in spec-write order. The review-rework
  // re-entry writes 'in_flight'; the merged/handed-off tail writes merged/done.
  readonly specStatuses: string[] = [];
  private readonly costRows: Array<{ id: string; total_tokens: number; billing_mode: string }> = [];
  private nextCostId = 1;
  private ciTask: { taskId: string; attempt: number } | undefined;

  // The project config row the review/merge tail loads. Defaults to the
  // not_configured hand-off; tests pass { mergeIntegration: "direct_merge",
  // governancePosture: "open", ... } to exercise the direct-merge branches.
  private readonly projectConfig: Record<string, unknown>;

  constructor(
    private readonly runContext: PlannerRunContext,
    projectConfig?: Record<string, unknown>,
  ) {
    // A valid version:1 project config — migrateProjectConfig now fails hard on
    // an unversioned/`{}` row (the migration shim is deleted). The static
    // GitHub credential ref lives under `credentials` (strict V1 schema).
    this.projectConfig = projectConfig ?? {
      version: 1,
      ...(runContext.githubCredentialRef === undefined
        ? {}
        : { credentials: { githubCredentialRef: runContext.githubCredentialRef } }),
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      return { rows: [...this.costRows], rowCount: this.costRows.length };
    }
    if (trimmed.startsWith("UPDATE cost_records SET")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      // total_tokens $12 (idx 11); billing_mode $15 (idx 14, after notional_cost_usd $14).
      const id = String(this.nextCostId++);
      this.costRows.push({
        id,
        total_tokens: Number(params[11] ?? 0),
        billing_mode: String(params[14] ?? "self_hosted"),
      });
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
            config: this.projectConfig,
            // P3-0008 review/merge context columns (shares this SELECT prefix).
            default_branch: "main",
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith("UPDATE specs SET status = 'in_flight'")) {
      // The review-rework re-entry sets the spec back in_flight (status inline,
      // $1 = spec_id) before re-running the loop against the reviewer feedback.
      this.specStatuses.push("in_flight");
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE specs SET status = $2")) {
      // The merged / handed-off tail sets the final spec status ($2 = status).
      this.specStatuses.push(String(params[1]));
      return { rows: [], rowCount: 1 };
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

  // A minimal `connect()` so seams that open a `runWithOrgScope` /
  // `runWithSystemScope` transaction (e.g. the BUDGET-SAFETY M6 PgBudgetGate
  // preflight) work over this fake: the client routes `query` back here, `release()`
  // is a no-op, and the budget read hits the catch-all (empty → unlimited no-op).
  async connect(): Promise<{ query: PlannerRunPool["query"]; release: () => void }> {
    return { query: this.query.bind(this), release: () => {} };
  }

  asPgPool() {
    return this as never;
  }
}
