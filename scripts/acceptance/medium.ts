// P2A-0015: `just acceptance-medium` — medium-tier acceptance gate.
//
// The medium tier drives the REAL planner feedback loop (runSubtaskLoop via
// runPlannerLoopWorkflow) against a fixture repo whose first writer attempt is
// expected to need ≥ 2 subtasks and at least one checker-rejection re-plan. It
// asserts the persisted planner+writer+checker+auditor cost records, ≥ 2 write
// tasks, ≥ 1 planner.rerequested event, a draft PR, and CI pass — then upgrades
// the persisted outcome to phase2_medium_complete.
//
// LOCAL ONLY — calls real Codex CLIs over SSH and creates a real draft PR. The
// operator must point github_repo_url at a fixture-medium repo whose initial
// state trips the checker on the first pass (see docs/operator-guide/
// acceptance.md). The CI-gated dry run lives in phase2AcceptanceMedium.test.ts.

import { exit } from "node:process";
import type { ServerHostKeyAlgorithm } from "ssh2";
import type { AllocationRequest, Allocator, RunnerAllocation } from "../../services/orchestrator/src/engine/contracts/allocator.js";
import { FetchGitHubHttpClient } from "../../services/orchestrator/src/engine/providers/github.js";
import { Ssh2Substrate } from "../../services/orchestrator/src/engine/ssh/index.js";
import {
  createProject,
  createQueuedRunFromSpec,
  createSpec
} from "../../services/orchestrator/src/engine/workflow/projectSpec.js";
import { runPlannerLoopWorkflow } from "../../services/orchestrator/src/engine/workflow/plannerRun.js";
import {
  AcceptanceAssertionError,
  AcceptanceEnvError,
  assertAcceptanceCriteria,
  bootstrapAcceptanceContext,
  loadAcceptanceEnv,
  loadRunSnapshot,
  printProofBlock
} from "./common.js";

async function main(): Promise<void> {
  const env = await loadAcceptanceEnv();
  process.stdout.write(`tanren acceptance-medium: config loaded from ${env.configSource}\n`);
  const ctx = await bootstrapAcceptanceContext(env, "medium");
  const startedAt = new Date();
  const unique = Date.now();

  const project = await createProject(ctx.pool, {
    name: `phase2-acceptance-medium-${unique}`,
    repoUrl: env.githubRepoUrl,
    defaultBranch: env.baseBranch,
    config: { githubCredentialRef: ctx.githubCredentialRef }
  });
  const spec = await createSpec(ctx.pool, {
    projectId: project.projectId,
    title: `Implement status helpers (${unique})`,
    description: [
      "Implement the two status helpers in src/status.ts so the committed",
      "tests in tests/status.test.ts pass. Each helper is an independent",
      "change, and the suite must be green before completion."
    ].join(" "),
    acceptanceCriteria: [
      "src/status.ts exports ok(): returns a frozen (Object.freeze) { ok: true } with no extra keys",
      "src/status.ts exports fail(reason): trims surrounding whitespace from reason, throws on an empty or whitespace-only reason, and returns a frozen { ok: false, reason } with no extra keys",
      "tests/status.test.ts passes (verified deterministically by the repo's CI)"
    ]
  });
  const run = await createQueuedRunFromSpec(ctx.pool, {
    specId: spec.specId,
    branch: `tanren/phase2-acceptance-medium-${unique}`
  });

  try {
    const ssh = new Ssh2Substrate(ctx.secrets, {
      serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS)
    });
    const allocator = new StaticRunnerAllocator({
      host: env.sshHost,
      port: env.sshPort,
      username: env.sshUser,
      hostKeyFingerprint: env.sshHostFingerprint
    });

    // No buildAdapters / buildUsageProbe: the workflow defaults build real
    // Codex adapters (one shared CODEX_HOME) + a live codexbar/ccusage probe.
    const result = await runPlannerLoopWorkflow({
      pool: ctx.pool,
      allocator,
      ssh,
      secrets: ctx.secrets,
      githubHttp: new FetchGitHubHttpClient(),
      context: {
        runId: run.runId,
        specId: run.specId,
        projectId: run.projectId,
        repoUrl: env.githubRepoUrl,
        targetBranch: env.baseBranch,
        runBranch: run.branch,
        specTitle: spec.title,
        specDescription: spec.description,
        acceptanceCriteria: spec.acceptanceCriteria,
        runnerImage: project.runnerImage,
        identitySecretRef: ctx.identitySecretRef,
        githubCredentialRef: ctx.githubCredentialRef,
        codexCredentialRef: ctx.codexCredentialRef
      },
      escapeHatches: { maxPlannerRerunsPerSpec: 5, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: env.timeoutMs,
      maxCiPolls: env.maxCiPolls,
      ciPollDelayMs: env.ciPollDelayMs
    });

    if (result.outcome.kind !== "passed") {
      throw new AcceptanceAssertionError(
        `medium-tier planner loop did not pass: ${result.outcome.kind}`,
        run.runId
      );
    }

    // Runtime code paths set outcome='ok'; the Phase 2A gate names a distinct
    // persisted outcome the dashboard release-gate query filters on. The
    // acceptance script is the only writer of this value (mirrors the easy tier).
    await ctx.pool.query("UPDATE runs SET outcome = 'phase2_medium_complete' WHERE run_id = $1", [run.runId]);

    const snapshot = await loadRunSnapshot(ctx.pool, run.runId);
    assertAcceptanceCriteria({ tier: "medium", expectedOutcome: "phase2_medium_complete", snapshot });
    printProofBlock({ tier: "medium", snapshot, repoUrl: env.githubRepoUrl, startedAt, endedAt: new Date() });
  } finally {
    await ctx.pool.end().catch(() => undefined);
  }
}

class StaticRunnerAllocator implements Allocator {
  constructor(
    private readonly options: { host: string; port: number; username: string; hostKeyFingerprint: string }
  ) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return {
      runnerId: `runner_${request.runId}`,
      imageSha: `${request.runnerImage}@sha256:acceptance-medium`,
      target: {
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef
      }
    };
  }

  async release(): Promise<void> {
    // Reuses the long-lived dev runner the Phase 1 fixture lives-proved
    // against; the release-time wipe is exercised by the live allocator.
  }
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value === undefined
    ? undefined
    : (value.split(",").map((item) => item.trim()).filter((item) => item !== "") as ServerHostKeyAlgorithm[]);
}

main().catch((error) => {
  if (error instanceof AcceptanceEnvError) {
    process.stderr.write(`acceptance-medium env error: ${error.message}\n`);
    exit(2);
  }
  if (error instanceof AcceptanceAssertionError) {
    process.stderr.write(`acceptance-medium assertion failed:\n${error.message}\n`);
    if (error.runId !== undefined) {
      process.stderr.write(`investigate persisted run: ${error.runId}\n`);
    }
    exit(1);
  }
  process.stderr.write(`acceptance-medium crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exit(3);
});
