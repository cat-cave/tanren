// plannerRun.fixtures — shared fakes/scripted clients/builders for the
// runPlannerLoopWorkflow integration tests (extracted for the 500-line cap).
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
import { PlannerRunPool } from "./helpers/plannerRunPool.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { runWithJobOrgId, runWithSystemJobScope } from "@tanren/db";
import {
  runPlannerLoopWorkflow,
  type PlannerRunContext,
  type PlannerRunResult,
  type RunPlannerLoopInput,
} from "../src/engine/workflow/plannerRun.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

/** Run the planner-loop workflow under the EXPLICIT per-job SYSTEM + per-job
 *  ORG scope, mirroring production (the run worker wraps the workflow in
 *  `runWithSystemJobScope` + `runWithJobOrgId`). Audit finding D3/H3 sweep:
 *  the writer is REQUIRED — default to `DirectRunStateWriter` over the
 *  supplied pool (byte-identical to the prior direct path). */
export function runPlannerLoopScoped(
  input: Omit<RunPlannerLoopInput, "runStateWriter"> & {
    runStateWriter?: RunPlannerLoopInput["runStateWriter"];
  },
): Promise<PlannerRunResult> {
  const resolved: RunPlannerLoopInput = {
    ...input,
    runStateWriter: input.runStateWriter ?? new DirectRunStateWriter(input.pool),
  };
  // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration
  // enforces the tenant-scope invariant), so the fixture always provides it.
  return runWithSystemJobScope(() => runWithJobOrgId(input.context.orgId, () => runPlannerLoopWorkflow(resolved)));
}

export {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceProgress,
  convergenceStalled,
  incompleteCheck,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makeDesignOracle,
  makePlanner,
  makeTriage,
  makeWriter,
  p0Audit,
  p1Audit,
  triageAllSpecs,
  triageAllTasks,
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
    orgId: "org_planner_test",
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
    failure: null,
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
    failure: null,
  };
}

export function accounting(costUsd: number | null): CcusageAccounting {
  const totals = {
    inputTokens: 8,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 4,
    reasoningOutputTokens: 0,
    totalTokens: 12,
  };
  return { cli: "codex", totals, costUsd, perModel: [], capturedAt: "2026-05-28T00:00:00Z" };
}

export function fakeProbe(window: WindowObservation, acct: CcusageAccounting | null): UsageProbe {
  return {
    async observeWindow() {
      return window;
    },
    async observeAccounting() {
      return { ok: acct };
    },
  };
}

// adapter-set fixtures live in plannerRunAdapterFixtures.ts (500-line cap split).
export { loopStageAdapters, twoSubtaskAdapters } from "./plannerRunAdapterFixtures.js";

export async function setup(projectConfig?: Record<string, unknown>) {
  const ctx = context();
  const pool = new PlannerRunPool(ctx, projectConfig);
  const events = new FakeEventStore();
  // Share the FakeEventStore with the pool so an atomic-path INSERT INTO events
  // routed through `PgEventStore(fakePool)` still lands in `events.events`.
  pool.eventSink = events;
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: ctx.githubCredentialRef, token: "ghp_secretToken" });
  const allocator = new RecordingAllocator();
  const ssh = new RecordingSsh();
  return { ctx, pool, events, secrets, allocator, ssh };
}

// direct-merge + open posture; merge probe decides merged/conflict/failed.
export function directMergeConfig(): Record<string, unknown> {
  return {
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

// merge-OUTCOME-mapping fixtures: report the branch CLEAN + up to date.
function cleanFreshness() {
  return {
    readFreshness: async () => ({
      state: "clean" as const,
      behind: false,
      baseBranch: "main",
      headBranch: "tanren/run_1",
    }),
    // non-speculative fixtures never re-target (no speculative stack),
    // but the probe must satisfy the full MergeProbe contract.
    readBaseBranch: async () => "main",
    retargetBase: async () => {},
  };
}

// A freshness probe whose signal is `behind` (§5h: the `CodeHost`-derived ancestry — never
// `dirty`); the conflict is surfaced by the unified `baseShiftRebase` hook the merge stage
// wires. Paired with a `baseShiftRebase` that returns `conflict`, the resolver then declines
// → recoverable `conflict`. The land itself is the unconditional `MergeAuthority`.
export function conflictMerge() {
  return {
    ...cleanFreshness(),
    readFreshness: async () => ({
      state: "behind" as const,
      behind: true,
      baseBranch: "main",
      headBranch: "tanren/run_1",
    }),
  };
}

// A clean mergeability/branch-state probe — the freshness read for a land that proceeds
// to the `MergeAuthority` (no host `merge()`). Used both for the `direct_merge` land
// tests (paired with a `mergeAuthority` bundle) and the `not_configured` hand-off tests
// (where the merge stage hands off and never reads mergeability).
export function mergedMerge() {
  return { ...cleanFreshness() };
}

// inject an approving review probe so the post-CI review→merge tail completes without
// hitting GitHub. The default test-pool config resolves mergeIntegration=not_configured →
// the merge stage hands off (no land); the `direct_merge` configs pair this with a
// `mergeAuthority` bundle so the land flows through the authority.
export function approvingReview() {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({
      verdict: "approved" as const,
      latest: { state: "approved" as const, reviewer: "reviewer-bot" },
    }),
  };
}

// Alias of `mergedMerge` (a clean freshness probe). Kept as a named fixture for the
// hand-off / non-land tests that just need a contract-complete probe.
export function noopMerge() {
  return { ...cleanFreshness() };
}

// The authority-land oracle (`plannerAuthorityHost` / `plannerAuthorityBundle`) lives in
// plannerRunAuthority.fixtures.ts; re-exported so existing import sites keep pulling it here.
export {
  PLANNER_AUTHORITY_HEAD_SHA,
  PLANNER_AUTHORITY_REPO,
  plannerAuthorityBundle,
  plannerAuthorityHost,
} from "./plannerRunAuthority.fixtures.js";
// The RLS-lifecycle land bundle (real writer-backed finalizer) — re-exported so the
// lifecycle integration test pulls it through this one fixtures barrel (dep-cap friendly).
export { lifecycleAuthorityBundle } from "./rlsRunLifecycleAuthority.fixtures.js";

// The forge calls of a passing native run: PR-list + create, then the `tanren/gate`
// verdict-PUBLISH (a COMMIT STATUS, `POST /statuses/{sha}` → 201, NOT a check-run —
// check-runs are Apps-only so a token credential gets 403). NATIVE delivery runs the merge
// gate over the substrate (no forge poll); the 201 is consumed only on a real-head-sha fake.
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
    { status: 201, body: {} },
  ]);
}

export class RecordingAllocator implements Allocator {
  readonly taxonomy = "fixed_pool" as const;
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

// Passing SSH fake: exit-0 + empty stdout by default. The evidence harvester's read script
// (uniquely identified by the `__TANREN_FILE_ABSENT__` marker) returns a one-test XML so
// the default-config's pre_audit/pre_merge junit-evidence gate passes (apex v57 task #64).
export class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];
  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const stdout = command.command.includes("__TANREN_FILE_ABSENT__")
      ? '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>'
      : "";
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
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

// `PlannerRunPool` lives in `helpers/plannerRunPool.ts` — re-exported here so
// existing test imports (`import { PlannerRunPool } from "./plannerRun.fixtures"`) work.
export { PlannerRunPool };
