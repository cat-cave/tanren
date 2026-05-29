/**
 * acceptanceHardTier.fixtures — the scripted fakes, gates, and seeded-run setup
 * for the P3-0026 hard-tier acceptance test. Extracted from
 * acceptanceHardTier.test.ts to keep that file under the 500-line cap.
 */
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { AnswererAdapter, CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";
import {
  buildPlan,
  loopAudit,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";
import { WorkerPool } from "./helpers/workerPool.js";

export const target: SshTarget = {
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
      return accounting();
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
  // Checker always passes — pass 1's re-plan must come from the gate, not the
  // checker, so the gate branch is unambiguously exercised.
  const checker = makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>;
  // Auditor: reject once (loop_to_planner), then pass.
  const auditor = makeAuditor([loopAudit, passingAudit]) as AnswererAdapter<AuditAnswer>;
  const writer = makeWriter(["diff --git a/file\n+ok\n"]);

  let gateCall = 0;
  const runGate = async ({ when }: { when: CiWhen; taskId?: string }): Promise<GateOutcome> => {
    trace.gateCalls.push({ when });
    gateCall += 1;
    // First gate call (the first per_iteration) fails → forces a re-plan.
    return gateCall === 1 ? failingGate() : passingGate;
  };

  let mergeCall = 0;

  return (input: Parameters<typeof runPlannerLoopWorkflow>[0]) =>
    runPlannerLoopWorkflow({
      ...input,
      githubHttp: github,
      maxCiPolls: 1,
      ciPollDelayMs: 0,
      sleep: async () => undefined,
      runBootstrap: async () => undefined,
      runGate,
      buildAdapters: () => ({ planner, writer, checker, auditor }),
      buildUsageProbe: () => fakeProbe(),
      reviewProbe: {
        markReady: async () => undefined,
        fetchVerdict: async () => ({
          verdict: "approved" as const,
          latest: { state: "approved" as const, reviewer: "reviewer-bot" },
        }),
      },
      mergeProbe: {
        applyQueueLabel: async () => undefined,
        merge: async () => {
          mergeCall += 1;
          trace.mergeAttempts = mergeCall;
          // First merge attempt conflicts; after the resolver runs the retry
          // (second call) succeeds.
          return mergeCall === 1
            ? {
                merged: false,
                mergeSha: undefined,
                conflict: true,
                status: 409,
                message: "merge conflict",
              }
            : {
                merged: true,
                mergeSha: "merge-sha",
                conflict: false,
                status: 200,
                message: "merged",
              };
        },
      },
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
  const project = await createProject(pool.asPgPool(), {
    name: "hard-tier-test",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-hard",
    defaultBranch: "main",
    config: {
      version: 1,
      credentials: { codexCredentialRef, githubCredentialRef },
      // direct_merge + open posture so the merge stage actually attempts a merge
      // (the conflict branch) without needing a contributor probe.
      mergeIntegration: "direct_merge",
      governancePosture: "open",
    },
  });
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
  return { pool, secrets, run };
}

export class RecordingAllocator implements Allocator {
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: "runner_hard", imageSha: "sha256:hard", target };
  }

  async release(): Promise<void> {}
}

export class RecordingSsh implements SshSubstrate {
  async run(_target: SshTarget, _command: SshCommand): Promise<SshCommandResult> {
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
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}
