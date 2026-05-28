// P2A-0015 (medium tier): the real planner-loop run-trigger. This is the
// production analogue of runPhase1FixtureWorkflow, but instead of a linear
// write/check/audit it drives the full P2A-0012 planner feedback loop
// (runSubtaskLoop) with real Codex adapters and a live usage probe.
//
// The workflow stays generic and testable: adapters + the usage probe are
// built through injectable factories that DEFAULT to real Codex / SSH usage
// monitors. Tests inject fakes (and omit codexCredentialRef so no auth is
// materialized). The acceptance driver (scripts/acceptance/medium.ts) uses the
// defaults to exercise the live path end-to-end.
//
// On a passing loop the workflow publishes a draft PR and polls CI (the same
// tail Phase 1 lives-proved), then upgrades run state. Non-pass loop outcomes
// (window_exhausted / retry_budget_exhausted / halted) map to a halted run
// without a PR. A Codex usage-limit thrown mid-loop is caught and recorded as
// window_exhausted rather than a generic failure (PROJECT_BRIEF §4.3).
import type pg from "pg";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { EscapeHatches } from "../config/shared.js";
import type { Allocator, RunnerAllocation, SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import { type EventName, type EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { CodexUsageLimitError, createCodexAnswerer, createCodexWriter } from "../providers/codex.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";
import { pollCiForRun, type PollCiForRunResult } from "./ciPolling.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import { runSubtaskLoop, type SubtaskLoopAdapters, type SubtaskLoopOutcome } from "./subtaskLoop.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PlannerRunContext {
  runId: string;
  specId: string;
  projectId: string;
  repoUrl: string;
  targetBranch: string;
  runBranch: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  behaviorIds?: string[];
  behaviorContext?: ReadonlyArray<{ id: string; title: string; description: string }>;
  runnerImage: string;
  identitySecretRef: string;
  githubCredentialRef: string;
  // Required to build the default (real Codex) adapters + usage probe. Tests
  // that inject buildAdapters/buildUsageProbe may omit it.
  codexCredentialRef?: string;
}

export interface PlannerRunAdapterContext {
  runId: string;
  target: SshTarget;
  // The shared per-run CODEX_HOME every Codex role materializes against, so a
  // single ccusage read at run end sees the whole run and the codexbar window
  // pre-flight reads the run's account.
  codexHome: string;
}

export interface RunPlannerLoopInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  context: PlannerRunContext;
  escapeHatches: Pick<EscapeHatches, "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure">;
  timeoutMs: number;
  workspacePath?: string;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // Test seams. Omitted in production → real Codex adapters + SSH usage probe.
  buildAdapters?: (ctx: PlannerRunAdapterContext) => SubtaskLoopAdapters;
  buildUsageProbe?: (ctx: PlannerRunAdapterContext) => UsageProbe | undefined;
}

export interface PlannerRunResult {
  runId: string;
  workspacePath: string;
  outcome: SubtaskLoopOutcome;
  pullRequest?: PublishedDraftPullRequest;
  ci?: PollCiForRunResult;
}

export async function runPlannerLoopWorkflow(input: RunPlannerLoopInput): Promise<PlannerRunResult> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = input.context;
  const workspacePath = input.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const recorder = new CostRecorder(input.pool, eventStore);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({ runId: context.runId, specId: context.specId, projectId: context.projectId, taskId, eventType, payload });
  };

  await input.pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [context.runId]);
  await supersedeQueuedPlannerTask(input.pool, context.runId);
  const allocation = await input.allocator.allocate({
    runId: context.runId,
    projectId: context.projectId,
    runnerImage: context.runnerImage,
    identitySecretRef: context.identitySecretRef
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  try {
    await prepareWorkspace(input, allocation.target, workspacePath);
    await appendEvent("workspace.prepared", { workspacePath, repoUrl: context.repoUrl, targetBranch: context.targetBranch });

    const adapterCtx: PlannerRunAdapterContext = {
      runId: context.runId,
      target: allocation.target,
      codexHome: codexHomeForRun(context.runId)
    };
    const adapters = (input.buildAdapters ?? ((ctx) => defaultCodexAdapters(input, ctx)))(adapterCtx);
    const usageProbe = (input.buildUsageProbe ?? ((ctx) => defaultUsageProbe(input, ctx)))(adapterCtx);

    const outcome = await runSubtaskLoop({
      pool: input.pool,
      eventStore,
      recorder,
      adapters,
      context: {
        specTitle: context.specTitle,
        specDescription: context.specDescription,
        acceptanceCriteria: context.acceptanceCriteria,
        behaviorIds: context.behaviorIds ?? [],
        behaviorContext: context.behaviorContext ?? [],
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        workspacePath
      },
      escapeHatches: input.escapeHatches,
      timeoutMs: input.timeoutMs,
      usageProbe
    });

    if (outcome.kind !== "passed") {
      await finalizeNonPass(input.pool, context.runId, runOutcomeFor(outcome));
      return { runId: context.runId, workspacePath, outcome };
    }

    const pullRequest = await publishDraftPullRequest({
      pool: input.pool,
      eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      ssh: input.ssh,
      target: allocation.target,
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      workspacePath,
      repoUrl: context.repoUrl,
      targetBranch: context.targetBranch,
      runBranch: context.runBranch,
      title: `Tanren: ${context.specTitle}`,
      body: context.specDescription,
      githubCredentialRef: context.githubCredentialRef,
      timeoutMs: input.timeoutMs
    });
    const ci = await pollCiUntilTerminal(input);

    await input.pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [context.specId]);
    await input.pool.query("UPDATE runs SET status = 'done', outcome = 'ok', ended_at = now() WHERE run_id = $1", [context.runId]);
    return { runId: context.runId, workspacePath, outcome, pullRequest, ci };
  } catch (error) {
    if (error instanceof CodexUsageLimitError) {
      // Authenticated but out of quota mid-loop: a recoverable window state,
      // not a crash (PROJECT_BRIEF §4.3). Record it as such.
      await finalizeNonPass(input.pool, context.runId, "window_exhausted");
      await appendEvent("usage.window.pressure", {
        provider: "openai",
        slot: "primary",
        usedPercent: 100,
        resetsAt: new Date().toISOString()
      });
      throw error;
    }
    await input.pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
    throw error;
  } finally {
    await input.allocator.release(allocation.runnerId);
    await appendEvent("runner.released", { runnerId: allocation.runnerId });
  }
}

function defaultCodexAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const credentialRef = input.context.codexCredentialRef;
  if (credentialRef === undefined || credentialRef === "") {
    throw new Error("codexCredentialRef is required to build the default Codex adapters");
  }
  // All four roles share one runId → one CODEX_HOME (codexHomeForRun), so
  // ccusage at run end accounts for the whole run and codexbar reads the run's
  // subscription account. The loop is sequential, so there is no concurrent
  // write to the shared home.
  const deps = { secrets: input.secrets, ssh: input.ssh, target: ctx.target, credentialRef, runId: ctx.runId };
  return {
    planner: createCodexAnswerer<PlanAnswer>(deps),
    writer: createCodexWriter(deps),
    checker: createCodexAnswerer<CheckAnswer>(deps),
    auditor: createCodexAnswerer<AuditAnswer>(deps)
  };
}

function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  return new SshUsageProbe({
    monitor: new SshCodexbarUsageMonitor(input.ssh),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    timeoutMs: input.timeoutMs,
    pressureThresholdPercent: input.pressureThresholdPercent
  });
}

// Maps a non-pass loop outcome to the persisted run.outcome value. All map to a
// halted run (no PR); the distinct outcome value preserves WHY it stopped.
function runOutcomeFor(outcome: SubtaskLoopOutcome): "window_exhausted" | "retry_budget_exhausted" | "halted" {
  if (outcome.kind === "window_exhausted") {
    return "window_exhausted";
  }
  if (outcome.kind === "retry_budget_exhausted") {
    return "retry_budget_exhausted";
  }
  return "halted";
}

async function finalizeNonPass(
  pool: RunStateClient,
  runId: string,
  outcome: "window_exhausted" | "retry_budget_exhausted" | "halted"
): Promise<void> {
  await pool.query("UPDATE runs SET status = 'halted', outcome = $2, ended_at = now() WHERE run_id = $1", [runId, outcome]);
}

// The spec-run trigger pre-creates a queued 'plan' task + job_queue row for the
// async worker path. This workflow executes the run directly and the loop
// creates its own planner task, so the pre-created artifacts are vestigial —
// cancel them so the run does not carry a dangling queued task.
async function supersedeQueuedPlannerTask(pool: RunStateClient, runId: string): Promise<void> {
  await pool.query("UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'", [
    runId
  ]);
  await pool.query("UPDATE job_queue SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'", [runId]);
}

async function prepareWorkspace(input: RunPlannerLoopInput, target: SshTarget, workspacePath: string): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(workspacePath)}`,
      `git clone --depth 1 --branch ${quoteSshShellArg(input.context.targetBranch)} ${quoteSshShellArg(input.context.repoUrl)} ${quoteSshShellArg(workspacePath)}`,
      `cd ${quoteSshShellArg(workspacePath)}`,
      "git config user.name 'Tanren Planner'",
      "git config user.email 'planner@tanren.invalid'"
    ].join(" && ")
  });
}

async function pollCiUntilTerminal(input: RunPlannerLoopInput): Promise<PollCiForRunResult> {
  const maxPolls = input.maxCiPolls ?? 12;
  const delayMs = input.ciPollDelayMs ?? 10_000;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: PollCiForRunResult | undefined;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    last = await pollCiForRun({
      pool: input.pool,
      eventStore: input.eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: input.context.runId,
      githubCredentialRef: input.context.githubCredentialRef
    });
    if (last.status === "passed") {
      return last;
    }
    if (last.status === "failed") {
      throw new Error(`planner-loop CI failed: ${last.reason}`);
    }
    if (attempt < maxPolls - 1) {
      await sleep(delayMs);
    }
  }
  throw new Error(`planner-loop CI did not finish after ${maxPolls} polls: ${last?.reason ?? "not_polled"}`);
}

function runnerPayload(allocation: RunnerAllocation) {
  return {
    runnerId: allocation.runnerId,
    imageSha: allocation.imageSha,
    target: {
      host: allocation.target.host,
      port: allocation.target.port,
      username: allocation.target.username,
      hostKeyFingerprint: allocation.target.hostKeyFingerprint
    }
  };
}
