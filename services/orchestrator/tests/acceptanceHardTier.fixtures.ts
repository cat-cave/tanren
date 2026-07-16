/**
 * acceptanceHardTier.fixtures — the scripted fakes, gates, and seeded-run setup
 * for the hard-tier acceptance test. Extracted from
 * acceptanceHardTier.test.ts to keep that file under the 500-line cap.
 */
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { CiWhen } from "../src/engine/ci/index.js";
import type {
  AllocationRequest,
  Allocator,
  RunnerAllocation,
  RunnerHandle,
} from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { provisionedGreenfieldProjectConfigProof } from "../src/engine/workflow/projectConfigWriteGuards.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";
import type { MergeAuthorityBundle } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceProgress,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makeDesignOracle,
  makePlanner,
  makeTriage,
  makeWriter,
  p1Audit,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";
import type { SubtaskLoopAdapters } from "../src/engine/workflow/subtaskLoop.js";
import { WorkerPool } from "./helpers/workerPool.js";

// Build the FULL SubtaskLoopAdapters set (SPEC-LOOP REDESIGN: planner/writer/checker/
// auditor + triage/convergence/demoRun) from the four core adapters, defaulting the
// new stages to route-to-task / progress / clean-demo. Keeps the hard-tier fakes
// concise while satisfying the loop's adapter contract.
export function fullAdapters(core: {
  planner: SubtaskLoopAdapters["planner"];
  writer: SubtaskLoopAdapters["writer"];
  checker: SubtaskLoopAdapters["checker"];
  auditor: SubtaskLoopAdapters["auditor"];
  triage?: SubtaskLoopAdapters["triage"];
  convergence?: SubtaskLoopAdapters["convergence"];
}): SubtaskLoopAdapters {
  return {
    planner: core.planner,
    writer: core.writer,
    checker: core.checker,
    auditor: core.auditor,
    triage: core.triage ?? makeTriage([triageAllTasks]),
    convergence: core.convergence ?? makeConvergence([convergenceProgress]),
    demoRun: makeDemoRun([{ findings: [], summary: "ok" }]),
    designOracle: makeDesignOracle([]),
  };
}

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
export const identitySecretRef = "runner/test/identity";

export function healthyWindow(): WindowObservation {
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

export function accounting(): CcusageAccounting {
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

export function fakeProbe(): UsageProbe {
  return {
    async observeWindow() {
      return healthyWindow();
    },
    async observeAccounting() {
      return { ok: accounting() };
    },
  };
}

// A failing per_iteration gate, shaped exactly like runGateForWhen's failure
// branch so subtaskLoop's gateRejection routes it back to the planner.
export function failingGate(): Extract<GateOutcome, { passed: false }> {
  const failedStep = {
    name: "unit",
    run: "pnpm test",
    exitCode: 1,
    passed: false,
    timedOut: false,
    outputTail: "1 failing test",
  };
  return {
    passed: false,
    results: [
      {
        passed: false,
        tier: "fast",
        when: "per_iteration",
        failedStep: "unit",
        exitCode: 1,
        steps: [failedStep],
      },
    ],
    failure: {
      passed: false,
      tier: "fast",
      when: "per_iteration",
      failedStep: "unit",
      exitCode: 1,
      steps: [failedStep],
    },
  };
}

export const passingGate: Extract<GateOutcome, { passed: true }> = { passed: true, results: [] };

// Records every hard branch the run actually traverses so the test asserts the
// loops fired (not just that the run ended green).
export interface HardTierTrace {
  gateCalls: Array<{ when: string }>;
  // The land-path mergeability evaluations on the conflict scenario: the `dirty` freshness
  // read that surfaces the merge-time conflict, then the `clean` read the authority lands on.
  mergeAttempts: number;
  conflictResolved: number;
}

// The scripted hard-tier workflow runner: the REAL runPlannerLoopWorkflow with
// fakes injected through its seams. The planner emits a fresh single-subtask
// plan on every (re-)plan; the checker passes (so a re-plan is driven by the
// GATE, not the checker, on pass 1); the auditor rejects once then passes; the
// gate fails the FIRST per_iteration call then passes; the merge conflicts once
// then succeeds after the resolver hook.
export function hardTierWorkflowRunner(github: GitHubHttpClient, trace: HardTierTrace) {
  const plans: PlanAnswer[] = [
    buildPlan([{ title: "T1", intent: "first attempt", behaviorIds: ["B1"] }]),
    buildPlan([{ title: "T1", intent: "fix the failing gate", behaviorIds: ["B1"] }]),
    buildPlan([{ title: "T1", intent: "address the auditor", behaviorIds: ["B1"] }]),
  ];
  const planner = makePlanner(plans);
  // Checker always reports complete — so the writer→gate→checker inner loop turns over
  // cleanly once the fast gate passes; the re-plan is driven by the AUDITOR's P1 finding
  // (via triage→convergence), not the checker.
  const checker = makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>;
  // Auditor: a P1 finding once (→ triage routes a task → convergence reports progress →
  // re-plan), then audited-clean → pass.
  const auditor = makeAuditor([p1Audit, cleanAudit]) as AnswererAdapter<AuditAnswer>;
  const writer = makeWriter(["diff --git a/file\n+ok\n"]);

  let gateCall = 0;
  const runGate = async ({ when }: { when: CiWhen; taskId?: string }): Promise<GateOutcome> => {
    trace.gateCalls.push({ when });
    gateCall += 1;
    // The first per_iteration (fast) gate fails → the writer re-iterates (NOT a re-plan);
    // every later call passes, so the task completes and the spec-gate is green.
    return gateCall === 1 ? failingGate() : passingGate;
  };

  let mergeCall = 0;

  return (input: Parameters<typeof runPlannerLoopWorkflow>[0]) =>
    runPlannerLoopWorkflow({
      ...input,
      githubHttp: github,
      ciPollDelayMs: 0,
      sleep: async () => {},
      runBootstrap: async () => {},
      runGate,
      buildAdapters: () => fullAdapters({ planner, writer, checker, auditor }),
      buildUsageProbe: () => fakeProbe(),
      reviewProbe: {
        markReady: async () => {},
        fetchVerdict: async () => ({
          verdict: "approved" as const,
          latest: { state: "approved" as const, reviewer: "reviewer-bot" },
        }),
      },
      mergeProbe: {
        // §5h: the branch is `behind` on the freshness read (the `CodeHost`-derived ancestry —
        // never `dirty`); the unified `baseShiftRebase` hook surfaces the merge-time CONFLICT.
        // After the resolver reconciles it the freshness reads `clean` and the authority lands
        // the resolved tree — the SAME merge-time conflict + resolver path, now jj-owned.
        // `mergeAttempts` counts the land-path freshness evaluations (conflict → success).
        readFreshness: async () => {
          mergeCall += 1;
          trace.mergeAttempts = mergeCall;
          return mergeCall === 1
            ? { state: "behind" as const, behind: true, baseBranch: "main", headBranch: "tanren/run_hard" }
            : { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "tanren/run_hard" };
        },
        readBaseBranch: async () => "main",
        retargetBase: async () => {},
      },
      // §5h: the `behind` rebase routes through the unified base-shift hook, which surfaces
      // the conflict (jj owns conflict). Inject a scripted hook so the no-DB run never
      // allocates a runner; it returns `conflict` to drive the resolver path.
      baseShiftRebase: async () => ({ outcome: "conflict", message: "branch conflicts with base" }),
      // The land is the unconditional `MergeAuthority` + CodeHost CAS; the resolved-tree
      // re-gate runs through the same `runGate` (passes), then the authority lands.
      mergeAuthority: hardTierAuthorityBundle(),
      resolveConflict: async (_context: ConflictContext) => {
        trace.conflictResolved += 1;
        return { resolved: true };
      },
    });
}

export async function setupSeededRun() {
  const pool = new WorkerPool();
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: githubCredentialRef, token: "ghp_secretToken" });
  const project = await createProject(
    pool.asPgPool(),
    {
      name: "hard-tier-test",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-hard",
      defaultBranch: "main",
      config: {
        version: 1,
        credentials: {
          defaultLlm: { cli: "codex", model: "default", authRef: codexCredentialRef },
          githubCredentialRef,
        },
        // direct_merge + open posture so the merge stage actually attempts a merge
        // (the conflict branch) without needing a contributor probe.
        mergeIntegration: "direct_merge",
        governancePosture: "open",
      },
    },
    undefined,
    { configWriteProof: provisionedGreenfieldProjectConfigProof },
  );
  const spec = await createSpec(pool.asPgPool(), {
    projectId: project.projectId,
    title: "Hard-tier scenario",
    description: "Force a re-plan, an auditor rejection, and a merge conflict.",
    acceptanceCriteria: ["all behaviors satisfied", "merges cleanly"],
  });
  const run = await createQueuedRunFromSpec(pool.asPgPool(), {
    specId: spec.specId,
    branch: "tanren/hard-tier",
  });
  // A plan run is a TENANT run (runs.org_id NOT NULL); the worker fails closed on a
  // null-org plan job. So the seeded run carries a concrete org — the pool reports
  // it and the enqueue stamps it.
  pool.forcedProjectOrgId = SEEDED_ORG_ID;
  return { pool, secrets, run, orgId: SEEDED_ORG_ID };
}

/** The org the seeded hard-tier run belongs to (a plan run always carries an org). */
export const SEEDED_ORG_ID = "org_hard_tier_seed";

/** Enqueue the seeded run's plan job carrying its org (a plan job always carries one). */
export async function enqueuePlanJob(
  jobQueue: FakeJobQueue,
  run: { runId: string; plannerTaskId: string },
  orgId: string = SEEDED_ORG_ID,
): Promise<void> {
  await jobQueue.enqueue({ runId: run.runId, taskId: run.plannerTaskId, taskKind: "plan", payload: {}, orgId });
}

export class RecordingAllocator implements Allocator {
  readonly taxonomy = "fixed_pool" as const;
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: "runner_hard", imageSha: "sha256:hard", target };
  }

  async release(): Promise<void> {}
}

export class RecordingSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

// PR publish + CI poll GitHub script (same tail the easy worker test uses). The
// merge stage is driven by the injected mergeProbe, not this HTTP client.
export function hardTierGitHub(): ScriptedGitHubHttp {
  return new ScriptedGitHubHttp([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 21,
        html_url: "https://github.com/cat-cave/tanren-fixture-hard/pull/21",
        draft: true,
        base: { ref: "main" },
      },
    },
    { status: 200, body: { head: { sha: "c".repeat(40), ref: "tanren/hard-tier" } } },
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
    // MERGE-SAFETY (self-identity): the authenticated clone's static `GET /user`
    // identity read, answered out-of-band so the ordered response queue is intact.
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

// The clean-clearing authority-land bundle for the hard-tier run (repo
// `cat-cave/tanren-fixture-hard`, PR head `tanren/run_hard`). The land is the
// unconditional `MergeAuthority` + CodeHost ff-only CAS (no host PR-merge); a test that
// drives the land to completion injects this as `mergeAuthority`.
const HARD_AUTHORITY_REPO = { owner: "cat-cave", name: "tanren-fixture-hard" };
export const HARD_AUTHORITY_HEAD_SHA = "sha-head";

export function hardTierAuthorityBundle(): MergeAuthorityBundle {
  const host = new InMemoryCodeHost();
  host.seed(HARD_AUTHORITY_REPO, "main", "sha-main");
  void host.pushRef({
    repo: HARD_AUTHORITY_REPO,
    localRef: "feat",
    remoteBranch: "tanren/run_hard",
    sha: HARD_AUTHORITY_HEAD_SHA,
  });
  return {
    codeHost: host,
    orgId: "org_hard",
    landStoreFor: () => ({
      persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
      recordLandReceipt: async () => ({ auditId: "audit_1" }),
    }),
    gateConfigHash: "a".repeat(64),
    policyVersion: "b".repeat(64),
    gateOutcome: { passed: true, results: [] },
    gatedHeadSha: HARD_AUTHORITY_HEAD_SHA,
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
    reviewVerdict: "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
  };
}
