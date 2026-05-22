import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Allocator, RunnerAllocation } from "../contracts/allocator.js";
import { type JobEnvelope, type JobQueue, PgJobQueue } from "../contracts/jobQueue.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { AuditAnswer, CheckAnswer } from "../providers/answererSchemas.js";
import { AnswererSchemaValidationError } from "../providers/codex.js";
import { fakeAuditor, fakeChecker } from "../providers/fake.js";
import type { AnswererAdapter, WriterResult } from "../providers/types.js";
import { prepareGitWorkspace, workspaceRepoPathForRun } from "../workspace/index.js";
import { executePlanTask, executeStructuredAuditTask, executeStructuredCheckTask } from "./answererTasks.js";
import { executeWriteTask } from "./writerTasks.js";

const defaultRunnerImage = "ghcr.io/cat-cave/tanren-runner:v0";
const defaultIdentitySecretRef = "runner/local-docker/identity";
const runnerProofCommand = "printf 'tanren-hello-over-ssh\\n'";
const expectedRunnerProofStdout = "tanren-hello-over-ssh\n";

type HelloTaskKind = "plan" | "write" | "check" | "audit";

interface HelloTaskDefinition {
  taskId: string;
  kind: HelloTaskKind;
  title: string;
  agentKind: "answerer" | "writer";
  model: string;
}

interface HelloJobPayload {
  taskId: string;
  kind: HelloTaskKind;
}

export interface HelloRunnerProof {
  runnerId: string;
  imageSha: string;
  target: {
    host: string;
    port: number;
    username: string;
    hostKeyFingerprint: string;
  };
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HelloRunSummary {
  runId: string;
  specId: string;
  projectId: string;
  outcome: "hello_world_complete";
  events: number;
  runnerProof: HelloRunnerProof;
}

export interface HelloWorkflowDependencies {
  allocator: Allocator;
  ssh: SshSubstrate;
  checkAnswerer?: AnswererAdapter<CheckAnswer>;
  auditAnswerer?: AnswererAdapter<AuditAnswer>;
  eventStore?: EventStore;
  jobQueue?: JobQueue<HelloJobPayload>;
  identitySecretRef?: string;
  runnerImage?: string;
  sshTimeoutMs?: number;
}

interface HelloWorkflowContext {
  runId: string;
  specId: string;
  projectId: string;
  appendEvent(input: { taskId?: string; eventType: string; payload: unknown }): Promise<void>;
}

interface HelloExecutionState {
  allocation: RunnerAllocation;
  ssh: SshSubstrate;
  timeoutMs: number;
  workspacePath: string;
  planTitle?: string;
  writer?: WriterResult;
  check?: CheckAnswer;
  checkAnswerer: AnswererAdapter<CheckAnswer>;
  auditAnswerer: AnswererAdapter<AuditAnswer>;
}

export async function runHelloWorkflow(pool: pg.Pool, dependencies: HelloWorkflowDependencies): Promise<HelloRunSummary> {
  const projectId = `project_${randomUUID()}`;
  const specId = `spec_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventStore = dependencies.eventStore ?? new PgEventStore(pool);
  const jobQueue = dependencies.jobQueue ?? new PgJobQueue<HelloJobPayload>(pool);
  let eventCount = 0;

  const context: HelloWorkflowContext = {
    runId,
    specId,
    projectId,
    async appendEvent(input) {
      await eventStore.append({ runId, specId, projectId, ...input });
      eventCount += 1;
    }
  };

  const tasks = helloTaskDefinitions();
  await insertHelloRunRows(pool, { projectId, specId, runId, runnerImage: dependencies.runnerImage ?? defaultRunnerImage });
  await context.appendEvent({ eventType: "hello.started", payload: {} });
  await queueHelloTasks(pool, context, jobQueue, tasks);
  await pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [runId]);
  await context.appendEvent({ eventType: "run.started", payload: { status: "running" } });

  try {
    const allocation = await allocateRunner(context, dependencies);
    const workspacePath = workspaceRepoPathForRun(runId);
    let runnerProof: HelloRunnerProof | undefined;

    try {
      runnerProof = await proveRunnerSsh(context, dependencies, allocation);
      await prepareWorkspace(context, dependencies, allocation, workspacePath);
      await drainHelloQueue(pool, context, jobQueue, tasks, {
        allocation,
        auditAnswerer: dependencies.auditAnswerer ?? fakeAuditor,
        checkAnswerer: dependencies.checkAnswerer ?? fakeChecker,
        ssh: dependencies.ssh,
        timeoutMs: dependencies.sshTimeoutMs ?? 10_000,
        workspacePath
      });
    } finally {
      await dependencies.allocator.release(allocation.runnerId);
      await context.appendEvent({ eventType: "runner.released", payload: { runnerId: allocation.runnerId } });
    }
    if (runnerProof === undefined) {
      throw new Error("runner proof missing after successful SSH proof");
    }

    await pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [specId]);
    await pool.query("UPDATE runs SET status = 'done', outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1", [runId]);
    await context.appendEvent({
      eventType: "run.completed",
      payload: { status: "done", outcome: "hello_world_complete" }
    });
    await context.appendEvent({
      eventType: "hello.completed",
      payload: { outcome: "hello_world_complete", runnerProof, workspacePath }
    });
    return { runId, specId, projectId, outcome: "hello_world_complete", events: eventCount, runnerProof };
  } catch (error) {
    await markRunFailed(pool, context, jobQueue, error);
    throw error;
  }
}

async function insertHelloRunRows(
  pool: pg.Pool,
  input: { projectId: string; specId: string; runId: string; runnerImage: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator)
     VALUES ($1, 'hello-world', 'https://github.com/cat-cave/tanren-fixture-easy', 'main', $2, 'local-docker')`,
    [input.projectId, input.runnerImage]
  );
  await pool.query(
    `INSERT INTO specs (spec_id, project_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, 'Hello world', 'Prove Tanren service connectivity', $3::jsonb, 'active')`,
    [input.specId, input.projectId, JSON.stringify(["A synthetic run completes and is visible"])]
  );
  await pool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, trigger, branch, status)
     VALUES ($1, $2, $3, 'cli', 'tanren/hello-world', 'queued')`,
    [input.runId, input.specId, input.projectId]
  );
}

async function queueHelloTasks(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  tasks: HelloTaskDefinition[]
): Promise<void> {
  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, $4, 'queued', $5, 'fake', $6)`,
      [task.taskId, context.runId, task.kind, task.title, task.agentKind, task.model]
    );
    const job = await jobQueue.enqueue({
      runId: context.runId,
      taskId: task.taskId,
      taskKind: task.kind,
      payload: { taskId: task.taskId, kind: task.kind }
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "task.queued",
      payload: { taskKind: task.kind, jobId: job.id }
    });
  }
}

async function drainHelloQueue(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  tasks: HelloTaskDefinition[],
  state: HelloExecutionState
): Promise<void> {
  for (const task of tasks) {
    const job = await jobQueue.claim(task.kind, { runId: context.runId });
    if (job === undefined || job.taskId !== task.taskId) {
      throw new Error(`durable hello queue missing ${task.kind} task`);
    }
    await runClaimedHelloTask(pool, context, jobQueue, task, job, state);
  }
}

async function runClaimedHelloTask(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  task: HelloTaskDefinition,
  job: JobEnvelope<HelloJobPayload>,
  state: HelloExecutionState
): Promise<void> {
  try {
    await pool.query("UPDATE tasks SET status = 'running', started_at = now() WHERE task_id = $1", [task.taskId]);
    await context.appendEvent({ taskId: task.taskId, eventType: "task.started", payload: { taskKind: task.kind, jobId: job.id } });
    await context.appendEvent({ taskId: task.taskId, eventType: `${roleScope(task.kind)}.started`, payload: { taskKind: task.kind } });
    await executeHelloTask(pool, context, task, state);
    await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [task.taskId]);
    await jobQueue.complete(job.id);
    await context.appendEvent({ taskId: task.taskId, eventType: "task.completed", payload: { taskKind: task.kind, jobId: job.id } });
  } catch (error) {
    const failure = failureForTask(task.kind, error);
    if (task.kind === "write") {
      await context.appendEvent({
        taskId: task.taskId,
        eventType: "workspace.failed",
        payload: { workspacePath: state.workspacePath, message: failure.message }
      });
    }
    await pool.query(
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
      [task.taskId, failure.kind]
    );
    await jobQueue.fail(job.id, failure);
    await context.appendEvent({ taskId: task.taskId, eventType: `${roleScope(task.kind)}.failed`, payload: failure });
    await context.appendEvent({ taskId: task.taskId, eventType: "task.failed", payload: { taskKind: task.kind, jobId: job.id, ...failure } });
    throw error;
  }
}

async function executeHelloTask(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  task: HelloTaskDefinition,
  state: HelloExecutionState
): Promise<void> {
  if (task.kind === "plan") {
    state.planTitle = await executePlanTask();
    const plan = {
      subtasks: [
        {
          title: state.planTitle,
          acceptanceCriteria: ["The orchestrator persists a completed synthetic run"]
        }
      ]
    };
    await context.appendEvent({ taskId: task.taskId, eventType: "planner.completed", payload: plan });
    return;
  }
  if (task.kind === "write") {
    state.writer = await executeWriteTask({
      allocation: state.allocation,
      prompt: state.planTitle ?? "Write hello world",
      ssh: state.ssh,
      timeoutMs: state.timeoutMs,
      workspacePath: state.workspacePath
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "workspace.git_captured",
      payload: { workspacePath: state.workspacePath, commits: state.writer.commits, diffBytes: Buffer.byteLength(state.writer.diff, "utf8") }
    });
    await context.appendEvent({ taskId: task.taskId, eventType: "writer.completed", payload: state.writer });
    await insertFakeWriterCost(pool, context, task.taskId, state.writer);
    return;
  }
  if (task.kind === "check") {
    state.check = await executeStructuredCheckTask(state.checkAnswerer, {
      specTitle: "Hello world",
      specDescription: "Prove Tanren service connectivity",
      acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
      writerDiff: state.writer?.diff ?? "",
      timeoutMs: state.timeoutMs
    });
    await context.appendEvent({ taskId: task.taskId, eventType: "checker.completed", payload: state.check });
    return;
  }
  const audit = await executeStructuredAuditTask(state.auditAnswerer, {
    specTitle: "Hello world",
    acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
    checkAnswer: state.check ?? { done: false, reason: "No checker answer was recorded.", suggested_fixes: ["Run checker first."] },
    writerDiff: state.writer?.diff ?? "",
    timeoutMs: state.timeoutMs
  });
  await context.appendEvent({ taskId: task.taskId, eventType: "auditor.completed", payload: audit });
}

async function insertFakeWriterCost(pool: pg.Pool, context: HelloWorkflowContext, taskId: string, writer: WriterResult): Promise<void> {
  if (writer.tokenUsage === undefined) {
    throw new Error("fake writer cost requires token usage");
  }
  await pool.query(
    `INSERT INTO cost_records
     (task_id, run_id, project_id, cli, provider, model, input_tokens, output_tokens, cached_tokens,
      cost_usd, pricing_mode, cost_source, cost_source_raw)
     VALUES ($1, $2, $3, 'fake', 'fake', 'fake-writer', $4, $5, $6, 0,
             'opportunity_cost', 'opportunity_computed', $7::jsonb)`,
    [
      taskId,
      context.runId,
      context.projectId,
      writer.tokenUsage.inputTokens,
      writer.tokenUsage.outputTokens,
      writer.tokenUsage.cachedTokens,
      JSON.stringify({ source: "hello-world fake adapter" })
    ]
  );
}

async function allocateRunner(context: HelloWorkflowContext, dependencies: HelloWorkflowDependencies): Promise<RunnerAllocation> {
  const runnerImage = dependencies.runnerImage ?? defaultRunnerImage;
  const identitySecretRef = dependencies.identitySecretRef ?? defaultIdentitySecretRef;
  const allocationRequest = { runId: context.runId, projectId: context.projectId, runnerImage, identitySecretRef };

  await context.appendEvent({ eventType: "allocator.requested", payload: { allocator: "local-docker", runnerImage, identitySecretRef } });

  try {
    const allocation = await dependencies.allocator.allocate(allocationRequest);
    await context.appendEvent({ eventType: "allocator.allocated", payload: runnerAllocationPayload(allocation) });
    await context.appendEvent({ eventType: "runner.allocated", payload: runnerAllocationPayload(allocation) });
    return allocation;
  } catch (error) {
    await context.appendEvent({ eventType: "allocator.failed", payload: { message: messageFromError(error) } });
    throw error;
  }
}

async function proveRunnerSsh(
  context: HelloWorkflowContext,
  dependencies: HelloWorkflowDependencies,
  allocation: RunnerAllocation
): Promise<HelloRunnerProof> {
  await context.appendEvent({
    eventType: "hello.ssh_started",
    payload: {
      runnerId: allocation.runnerId,
      command: runnerProofCommand,
      target: runnerAllocationPayload(allocation).target
    }
  });
  const result = await dependencies.ssh.run(allocation.target, {
    command: runnerProofCommand,
    timeoutMs: dependencies.sshTimeoutMs ?? 10_000
  });
  if (result.failure !== undefined || result.exitCode !== 0 || result.stdout !== expectedRunnerProofStdout) {
    await context.appendEvent({
      eventType: "runner.failed",
      payload: { runnerId: allocation.runnerId, command: runnerProofCommand, result }
    });
    throw new Error(`hello SSH proof failed for ${allocation.runnerId}: ${runnerProofFailureText(result)}`);
  }
  const proof = runnerProofPayload(allocation, result);
  await context.appendEvent({ eventType: "hello.ssh_completed", payload: proof });
  return proof;
}

async function prepareWorkspace(
  context: HelloWorkflowContext,
  dependencies: HelloWorkflowDependencies,
  allocation: RunnerAllocation,
  workspacePath: string
): Promise<void> {
  try {
    await prepareGitWorkspace({
      ssh: dependencies.ssh,
      target: allocation.target,
      workspacePath,
      timeoutMs: dependencies.sshTimeoutMs ?? 10_000
    });
    await context.appendEvent({ eventType: "workspace.prepared", payload: { runnerId: allocation.runnerId, workspacePath } });
  } catch (error) {
    await context.appendEvent({
      eventType: "workspace.failed",
      payload: { runnerId: allocation.runnerId, workspacePath, message: messageFromError(error) }
    });
    throw error;
  }
}

async function markRunFailed(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  error: unknown
): Promise<void> {
  const failure = { kind: "run_failed", message: messageFromError(error) };
  const queuedTasks = await pool.query(
    `UPDATE tasks
     SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now()
     WHERE run_id = $1 AND status = 'queued'
     RETURNING task_id, kind`,
    [context.runId, failure.kind]
  );
  await jobQueue.failQueuedForRun(context.runId, failure);
  for (const task of queuedTasks.rows) {
    await context.appendEvent({
      taskId: String(task.task_id),
      eventType: "task.failed",
      payload: { taskKind: task.kind, ...failure }
    });
  }
  await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
  await context.appendEvent({ eventType: "run.failed", payload: { status: "failed", message: failure.message } });
}

function helloTaskDefinitions(): HelloTaskDefinition[] {
  return [
    { taskId: `task_${randomUUID()}`, kind: "plan", title: "Fake planner", agentKind: "answerer", model: "fake-planner" },
    { taskId: `task_${randomUUID()}`, kind: "write", title: "Fake writer", agentKind: "writer", model: "fake-writer" },
    { taskId: `task_${randomUUID()}`, kind: "check", title: "Fake checker", agentKind: "answerer", model: "fake-checker" },
    { taskId: `task_${randomUUID()}`, kind: "audit", title: "Fake auditor", agentKind: "answerer", model: "fake-auditor" }
  ];
}

function roleScope(kind: HelloTaskKind): "planner" | "writer" | "checker" | "auditor" {
  if (kind === "plan") {
    return "planner";
  }
  if (kind === "write") {
    return "writer";
  }
  if (kind === "check") {
    return "checker";
  }
  return "auditor";
}

function failureForTask(kind: HelloTaskKind, error: unknown): { kind: string; message: string } {
  if (error instanceof AnswererSchemaValidationError) {
    return { kind: "schema_validation_failed", message: error.message };
  }
  return { kind: `${kind}_failed`, message: messageFromError(error) };
}

function runnerAllocationPayload(allocation: RunnerAllocation) {
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

function runnerProofPayload(allocation: RunnerAllocation, result: SshCommandResult): HelloRunnerProof {
  return {
    ...runnerAllocationPayload(allocation),
    command: runnerProofCommand,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runnerProofFailureText(result: SshCommandResult): string {
  if (result.failure !== undefined) {
    return "message" in result.failure ? result.failure.message : result.failure.reason;
  }
  if (result.exitCode !== 0) {
    return `exit ${result.exitCode}`;
  }
  return `unexpected stdout ${JSON.stringify(result.stdout)}`;
}
