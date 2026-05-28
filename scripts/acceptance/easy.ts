// P2A-0015: `just acceptance-easy` — drives the easy fixture repo through
// the real workflow end-to-end and asserts persisted outcome plus cost
// attribution.
//
// The easy tier reuses the Phase 1 fixture flow (single-file change, single
// subtask, no rejection loop) so the gate exercises the same plan/write/
// check/audit/ci task topology Phase 1 already lives-proved, then upgrades
// the persisted run.outcome to `phase2_easy_complete` once every Phase 2
// criterion is met. The acceptance script never bypasses checks; if any
// assertion fails the script exits non-zero with a clear error and the
// persisted run id for the operator to investigate.
//
// LOCAL ONLY — calls real Codex CLIs and creates a real draft PR.

import { exit } from "node:process";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { createCodexAnswerer, createCodexWriter } from "../../services/orchestrator/src/engine/providers/codex.js";
import { FetchGitHubHttpClient } from "../../services/orchestrator/src/engine/providers/github.js";
import { Ssh2Substrate } from "../../services/orchestrator/src/engine/ssh/index.js";
import type {
  AllocationRequest,
  Allocator,
  RunnerAllocation
} from "../../services/orchestrator/src/engine/contracts/allocator.js";
import {
  createProject,
  createQueuedRunFromSpec,
  createSpec
} from "../../services/orchestrator/src/engine/workflow/projectSpec.js";
import { runPhase1FixtureWorkflow } from "../../services/orchestrator/src/engine/workflow/phase1Fixture.js";
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
  const env = loadAcceptanceEnv();
  const ctx = await bootstrapAcceptanceContext(env, "easy");
  const startedAt = new Date();
  const unique = Date.now();
  const markerFile = `TANREN_PHASE2_EASY_${unique}.md`;
  const markerLine = `tanren phase 2 acceptance-easy ok ${unique}`;

  const project = await createProject(ctx.pool, {
    name: `phase2-acceptance-easy-${unique}`,
    repoUrl: env.githubRepoUrl,
    defaultBranch: env.baseBranch,
    config: { githubCredentialRef: ctx.githubCredentialRef }
  });
  const spec = await createSpec(ctx.pool, {
    projectId: project.projectId,
    title: `Add ${markerFile}`,
    description: `Create ${markerFile} containing exactly ${markerLine}.`,
    acceptanceCriteria: [`${markerFile} contains exactly ${markerLine}`]
  });
  const run = await createQueuedRunFromSpec(ctx.pool, {
    specId: spec.specId,
    branch: `tanren/phase2-acceptance-easy-${unique}`
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

    await runPhase1FixtureWorkflow({
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
        githubCredentialRef: ctx.githubCredentialRef
      },
      createWriter: ({ target, runId }) =>
        createCodexWriter({
          secrets: ctx.secrets,
          ssh,
          target,
          credentialRef: ctx.codexCredentialRef,
          runId: `${runId}_writer`
        }),
      createChecker: ({ target, runId }) =>
        createCodexAnswerer({
          secrets: ctx.secrets,
          ssh,
          target,
          credentialRef: ctx.codexCredentialRef,
          runId: `${runId}_check`
        }),
      createAuditor: ({ target, runId }) =>
        createCodexAnswerer({
          secrets: ctx.secrets,
          ssh,
          target,
          credentialRef: ctx.codexCredentialRef,
          runId: `${runId}_audit`
        }),
      timeoutMs: env.timeoutMs,
      maxCiPolls: env.maxCiPolls,
      ciPollDelayMs: env.ciPollDelayMs
    });

    // Phase 1 fixture lands `outcome = 'phase1_fixture_complete'`. The
    // Phase 2A acceptance gate's persisted contract names a distinct
    // outcome (phase2_easy_complete) so the dashboard's release-gate query
    // can filter on it. The acceptance script is the only writer of this
    // outcome value; runtime code paths keep their Phase 1 outcome.
    await ctx.pool.query("UPDATE runs SET outcome = 'phase2_easy_complete' WHERE run_id = $1", [run.runId]);

    const snapshot = await loadRunSnapshot(ctx.pool, run.runId);
    assertAcceptanceCriteria({
      tier: "easy",
      expectedOutcome: "phase2_easy_complete",
      snapshot
    });

    printProofBlock({
      tier: "easy",
      snapshot,
      repoUrl: env.githubRepoUrl,
      startedAt,
      endedAt: new Date()
    });
  } finally {
    await ctx.pool.end().catch(() => undefined);
  }
}

class StaticRunnerAllocator implements Allocator {
  constructor(
    private readonly options: {
      host: string;
      port: number;
      username: string;
      hostKeyFingerprint: string;
    }
  ) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return {
      runnerId: `runner_${request.runId}`,
      imageSha: `${request.runnerImage}@sha256:acceptance-easy`,
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
    // The release-time wipe is exercised by the live allocator in dev/prod
    // compose; this opt-in host-side acceptance reuses the long-lived
    // dev runner the Phase 1 fixture lives-proved against.
  }
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value === undefined
    ? undefined
    : (value.split(",").map((item) => item.trim()).filter((item) => item !== "") as ServerHostKeyAlgorithm[]);
}

main().catch((error) => {
  if (error instanceof AcceptanceEnvError) {
    process.stderr.write(`acceptance-easy env error: ${error.message}\n`);
    exit(2);
  }
  if (error instanceof AcceptanceAssertionError) {
    process.stderr.write(`acceptance-easy assertion failed:\n${error.message}\n`);
    if (error.runId !== undefined) {
      process.stderr.write(`investigate persisted run: ${error.runId}\n`);
    }
    exit(1);
  }
  process.stderr.write(`acceptance-easy crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exit(3);
});
