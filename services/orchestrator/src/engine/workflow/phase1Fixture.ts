import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Allocator, RunnerAllocation, SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { type EventName, type EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { AuditAnswer, CheckAnswer } from "../providers/answererSchemas.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { emptyTokenUsage, type AnswererAdapter, type TokenUsage, type WriterAdapter, type WriterResult } from "../providers/types.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";
import { pollCiForRun, type PollCiForRunResult } from "./ciPolling.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import { executeStructuredAuditTask, executeStructuredCheckTask } from "./answererTasks.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

const QueuedPlannerRow = z.object({ task_id: z.string() });

export interface Phase1FixtureRunContext {
  runId: string;
  specId: string;
  projectId: string;
  repoUrl: string;
  targetBranch: string;
  runBranch: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  runnerImage: string;
  identitySecretRef: string;
  githubCredentialRef: string;
}

export interface Phase1FixtureAdapterContext {
  runId: string;
  target: SshTarget;
}

export interface RunPhase1FixtureInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  context: Phase1FixtureRunContext;
  createWriter(input: Phase1FixtureAdapterContext): WriterAdapter;
  createChecker(input: Phase1FixtureAdapterContext): AnswererAdapter<CheckAnswer>;
  createAuditor(input: Phase1FixtureAdapterContext): AnswererAdapter<AuditAnswer>;
  workspacePath?: string;
  timeoutMs: number;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Phase1FixtureResult {
  runId: string;
  workspacePath: string;
  writer: WriterResult;
  check: CheckAnswer;
  audit: AuditAnswer;
  pullRequest: PublishedDraftPullRequest;
  ci: PollCiForRunResult;
}

type Phase1TaskKind = "write" | "check" | "audit";

export async function runPhase1FixtureWorkflow(input: RunPhase1FixtureInput): Promise<Phase1FixtureResult> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = input.context;
  const workspacePath = input.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const recorder = new CostRecorder(input.pool, eventStore);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({ runId: context.runId, specId: context.specId, projectId: context.projectId, taskId, eventType, payload });
  };

  await input.pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [context.runId]);
  await appendEvent("phase1.fixture.started", { repoUrl: context.repoUrl, targetBranch: context.targetBranch });
  await completeQueuedPlannerTask(input.pool, appendEvent, context);
  const allocation = await input.allocator.allocate({
    runId: context.runId,
    projectId: context.projectId,
    runnerImage: context.runnerImage,
    identitySecretRef: context.identitySecretRef
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  try {
    await prepareFixtureWorkspace({ ...input, target: allocation.target, workspacePath });
    await appendEvent("workspace.prepared", { workspacePath, repoUrl: context.repoUrl, targetBranch: context.targetBranch });
    const adapterContext = { runId: context.runId, target: allocation.target };

    const writerAdapter = input.createWriter(adapterContext);
    const writerStartedAt = Date.now();
    const writer = await runFixtureTask(input.pool, appendEvent, context.runId, "write", "Writer fixture change", "writer", writerAdapter.cli, async (taskId) => {
      const result = await writerAdapter.runWriter({
        prompt: writerPrompt(context),
        workspace: workspacePath,
        timeoutMs: input.timeoutMs
      });
      await appendEvent("workspace.git_captured", { workspacePath, commits: result.commits, diffBytes: Buffer.byteLength(result.diff, "utf8") });
      await recordFixtureCost({
        recorder,
        context,
        taskId,
        cli: writerAdapter.cli,
        model: "phase1-fixture-writer",
        authRef: writerAdapter.authRef,
        tokenUsage: result.tokenUsage,
        runtimeSeconds: secondsSince(writerStartedAt),
        rawUsage: { role: "writer", telemetry: result.telemetry ?? null }
      });
      return result;
    });

    const checker = input.createChecker(adapterContext);
    const checkerStartedAt = Date.now();
    const check = await runFixtureTask(input.pool, appendEvent, context.runId, "check", "Check writer fixture output", "answerer", checker.cli, async (taskId) => {
      const answer = await executeStructuredCheckTask(checker, {
        specTitle: context.specTitle,
        specDescription: context.specDescription,
        acceptanceCriteria: context.acceptanceCriteria,
        writerDiff: writer.diff,
        timeoutMs: input.timeoutMs,
        workspace: workspacePath
      });
      if (!answer.done) {
        throw new Error(`fixture checker rejected writer output: ${answer.reason}`);
      }
      await recordFixtureCost({
        recorder,
        context,
        taskId,
        cli: checker.cli,
        model: "phase1-fixture-checker",
        authRef: checker.authRef,
        tokenUsage: undefined,
        runtimeSeconds: secondsSince(checkerStartedAt),
        rawUsage: { role: "checker" }
      });
      return answer;
    });

    const auditor = input.createAuditor(adapterContext);
    const auditorStartedAt = Date.now();
    const audit = await runFixtureTask(input.pool, appendEvent, context.runId, "audit", "Audit phase 1 fixture", "answerer", auditor.cli, async (taskId) => {
      const answer = await executeStructuredAuditTask(auditor, {
        specTitle: context.specTitle,
        acceptanceCriteria: context.acceptanceCriteria,
        checkAnswer: check,
        writerDiff: writer.diff,
        timeoutMs: input.timeoutMs,
        workspace: workspacePath
      });
      if (!answer.verified) {
        throw new Error(`fixture auditor rejected completion: ${answer.reason}`);
      }
      await recordFixtureCost({
        recorder,
        context,
        taskId,
        cli: auditor.cli,
        model: "phase1-fixture-auditor",
        authRef: auditor.authRef,
        tokenUsage: undefined,
        runtimeSeconds: secondsSince(auditorStartedAt),
        rawUsage: { role: "auditor" }
      });
      return answer;
    });

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
    const ci = await pollCiUntilTerminal(input, appendEvent);

    await input.pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [context.specId]);
    await input.pool.query("UPDATE runs SET status = 'done', outcome = 'phase1_fixture_complete', ended_at = now() WHERE run_id = $1", [
      context.runId
    ]);
    await appendEvent("phase1.fixture.completed", { prUrl: pullRequest.prUrl, ciStatus: ci.status });
    return { runId: context.runId, workspacePath, writer, check, audit, pullRequest, ci };
  } catch (error) {
    await input.pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
    await appendEvent("phase1.fixture.failed", { message: messageFromError(error) });
    throw error;
  } finally {
    await input.allocator.release(allocation.runnerId);
    await appendEvent("runner.released", { runnerId: allocation.runnerId });
  }
}

async function runFixtureTask<TOutput>(
  pool: RunStateClient,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  runId: string,
  kind: Phase1TaskKind,
  title: string,
  agentKind: "writer" | "answerer",
  cli: string,
  run: (taskId: string) => Promise<TOutput>
): Promise<TOutput> {
  const taskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, $3, $4, 'running', now(), $5, $6, NULL)`,
    [taskId, runId, kind, title, agentKind, cli]
  );
  await appendEvent("task.started", { taskKind: kind }, taskId);
  await appendRoleStarted(appendEvent, kind, taskId);
  try {
    const output = await run(taskId);
    await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [taskId]);
    await appendRoleCompleted(appendEvent, kind, output, taskId);
    await appendEvent("task.completed", { taskKind: kind }, taskId);
    return output;
  } catch (error) {
    const failure = failureForFixtureTask(kind, error);
    await pool.query("UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1", [
      taskId,
      failure.kind
    ]);
    await appendRoleFailed(appendEvent, kind, failure, taskId);
    await appendEvent("task.failed", { taskKind: kind, ...failure }, taskId);
    throw error;
  }
}

// Maps a thrown error from a fixture task body to the typed failure payload
// persisted on the row + emitted on the task.failed event. Cost-unknown is no
// longer a failure (the recorder records cost_usd = NULL instead), so there is
// no cost-specific failure branch here.
function failureForFixtureTask(kind: Phase1TaskKind, error: unknown): { kind: string; message: string } {
  return { kind: `${kind}_failed`, message: messageFromError(error) };
}

interface FixtureCostInput {
  recorder: CostRecorder;
  context: Phase1FixtureRunContext;
  taskId: string;
  cli: "codex" | "claude" | "opencode" | "fake";
  model: string;
  authRef: string;
  tokenUsage: TokenUsage | undefined;
  runtimeSeconds: number;
  rawUsage: Record<string, unknown>;
}

// recordFixtureCost is the single mandatory call at fixture task completion.
// Token accounting is mandatory; cost is best-effort (NULL when the ref has no
// per-token price basis), so this never fails the task for missing cost.
async function recordFixtureCost(input: FixtureCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  await input.recorder.record(
    {
      runId: input.context.runId,
      taskId: input.taskId,
      specId: input.context.specId,
      projectId: input.context.projectId,
      cli: input.cli,
      model: input.model,
      authRef: input.authRef,
      runtimeSeconds: input.runtimeSeconds
    },
    tokens,
    input.rawUsage
  );
}

function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}

async function appendRoleStarted(
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  kind: Phase1TaskKind,
  taskId: string
): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.started", { taskKind: kind }, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.started", { taskKind: kind }, taskId);
    return;
  }
  await appendEvent("auditor.started", { taskKind: kind }, taskId);
}

async function appendRoleCompleted<TOutput>(
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  kind: Phase1TaskKind,
  output: TOutput,
  taskId: string
): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.completed", output as EventPayload<"writer.completed">, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.completed", output as EventPayload<"checker.completed">, taskId);
    return;
  }
  await appendEvent("auditor.completed", output as EventPayload<"auditor.completed">, taskId);
}

async function appendRoleFailed(
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  kind: Phase1TaskKind,
  failure: { kind: string; message: string },
  taskId: string
): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.failed", failure, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.failed", failure, taskId);
    return;
  }
  await appendEvent("auditor.failed", failure, taskId);
}

async function completeQueuedPlannerTask(
  pool: RunStateClient,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  context: Phase1FixtureRunContext
): Promise<void> {
  const existing = await pool.query(
    `SELECT task_id
     FROM tasks
     WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'
     ORDER BY started_at ASC NULLS FIRST, task_id ASC
     LIMIT 1`,
    [context.runId]
  );
  const parsed = QueuedPlannerRow.safeParse(existing.rows[0]);
  if (!parsed.success) {
    return;
  }
  const taskId = parsed.data.task_id;
  await pool.query("UPDATE tasks SET status = 'running', started_at = now() WHERE task_id = $1", [taskId]);
  await appendEvent("task.started", { taskKind: "plan" }, taskId);
  await appendEvent("planner.started", { taskKind: "plan" }, taskId);
  const plan = {
    subtasks: [
      {
        title: context.specTitle,
        acceptanceCriteria: context.acceptanceCriteria
      }
    ]
  };
  await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [taskId]);
  await appendEvent("planner.completed", plan, taskId);
  await appendEvent("task.completed", { taskKind: "plan" }, taskId);
}

async function prepareFixtureWorkspace(input: RunPhase1FixtureInput & { target: SshTarget; workspacePath: string }): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "prepare phase 1 fixture workspace",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(input.workspacePath)}`,
      `git clone --depth 1 --branch ${quoteSshShellArg(input.context.targetBranch)} ${quoteSshShellArg(input.context.repoUrl)} ${quoteSshShellArg(input.workspacePath)}`,
      `cd ${quoteSshShellArg(input.workspacePath)}`,
      "git config user.name 'Tanren Phase 1 Fixture'",
      "git config user.email 'phase1-fixture@tanren.invalid'"
    ].join(" && ")
  });
}

async function pollCiUntilTerminal(
  input: RunPhase1FixtureInput,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>
): Promise<PollCiForRunResult> {
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
      throw new Error(`fixture CI failed: ${last.reason}`);
    }
    if (attempt < maxPolls - 1) {
      await appendEvent("phase1.fixture.ci_pending", { attempt: attempt + 1, nextPollAfterMs: delayMs });
      await sleep(delayMs);
    }
  }
  throw new Error(`fixture CI did not finish after ${maxPolls} polls: ${last?.reason ?? "not_polled"}`);
}

function writerPrompt(context: Phase1FixtureRunContext): string {
  return [
    `Implement this persisted Tanren spec: ${context.specTitle}`,
    context.specDescription,
    "",
    "Acceptance criteria:",
    ...context.acceptanceCriteria.map((criterion) => `- ${criterion}`)
  ].join("\n");
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

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
