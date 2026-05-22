import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Allocator, RunnerAllocation } from "./contracts/allocator.js";
import type { SshCommandResult, SshSubstrate } from "./contracts/sshSubstrate.js";
import { type EventStore, PgEventStore } from "./eventStore.js";
import { fakeAuditor, fakeChecker, fakePlanner, createFakeWriter } from "./providers/fake.js";
import type { WriterResult } from "./providers/types.js";
import { prepareGitWorkspace, workspaceRepoPathForRun } from "./workspace/index.js";

const defaultRunnerImage = "ghcr.io/cat-cave/tanren-runner:v0";
const defaultIdentitySecretRef = "runner/local-docker/identity";
const runnerProofCommand = "printf 'tanren-hello-over-ssh\\n'";
const expectedRunnerProofStdout = "tanren-hello-over-ssh\n";

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
  eventStore?: EventStore;
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

export async function runHelloWorkflow(pool: pg.Pool, dependencies: HelloWorkflowDependencies): Promise<HelloRunSummary> {
  const projectId = `project_${randomUUID()}`;
  const specId = `spec_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventStore = dependencies.eventStore ?? new PgEventStore(pool);
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

  await insertHelloRunRows(pool, { projectId, specId, runId, runnerImage: dependencies.runnerImage ?? defaultRunnerImage });
  await context.appendEvent({ eventType: "hello.started", payload: {} });

  try {
    const allocation = await allocateRunner(context, dependencies);
    const workspacePath = workspaceRepoPathForRun(runId);
    let runnerProof: HelloRunnerProof;

    try {
      runnerProof = await proveRunnerSsh(context, dependencies, allocation);
      await prepareWorkspace(context, dependencies, allocation, workspacePath);
      await runFakeAgentSteps(pool, context, {
        ssh: dependencies.ssh,
        target: allocation.target,
        workspacePath,
        timeoutMs: dependencies.sshTimeoutMs ?? 10_000
      });
    } finally {
      await dependencies.allocator.release(allocation.runnerId);
      await context.appendEvent({ eventType: "runner.released", payload: { runnerId: allocation.runnerId } });
    }
    if (runnerProof === undefined) {
      throw new Error("runner proof missing after successful SSH proof");
    }

    await pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [specId]);
    await pool.query("UPDATE runs SET outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1", [runId]);
    await context.appendEvent({
      eventType: "hello.completed",
      payload: { outcome: "hello_world_complete", runnerProof, workspacePath }
    });
    return { runId, specId, projectId, outcome: "hello_world_complete", events: eventCount, runnerProof };
  } catch (error) {
    await markRunFailed(pool, context, error);
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
    `INSERT INTO runs (run_id, spec_id, project_id, trigger, branch)
     VALUES ($1, $2, $3, 'cli', 'tanren/hello-world')`,
    [input.runId, input.specId, input.projectId]
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

async function runFakeAgentSteps(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  writerInput: { ssh: SshSubstrate; target: RunnerAllocation["target"]; workspacePath: string; timeoutMs: number }
): Promise<void> {
  const planTaskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
     VALUES ($1, $2, 'plan', 'Fake planner', 'done', 'ok', 'answerer', 'fake', 'fake-planner')`,
    [planTaskId, context.runId]
  );
  const plan = await fakePlanner.runAnswerer({ prompt: "Plan hello world", timeoutMs: 1_000 });
  await context.appendEvent({ taskId: planTaskId, eventType: "planner.completed", payload: plan });

  const writeTaskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
     VALUES ($1, $2, 'write', $3, 'running', null, 'writer', 'fake', 'fake-writer')`,
    [writeTaskId, context.runId, plan.subtasks[0]?.title ?? "Fake writer"]
  );
  const fakeWriter = createFakeWriter({ ssh: writerInput.ssh, target: writerInput.target });
  let writer: WriterResult;
  try {
    writer = await fakeWriter.runWriter({
      prompt: "Write hello world",
      workspace: writerInput.workspacePath,
      timeoutMs: writerInput.timeoutMs
    });
  } catch (error) {
    const payload = { workspacePath: writerInput.workspacePath, message: messageFromError(error) };
    await pool.query(
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = 'workspace_failed', ended_at = now() WHERE task_id = $1",
      [writeTaskId]
    );
    await context.appendEvent({ taskId: writeTaskId, eventType: "workspace.failed", payload });
    await context.appendEvent({ taskId: writeTaskId, eventType: "writer.failed", payload });
    throw error;
  }
  await context.appendEvent({
    taskId: writeTaskId,
    eventType: "workspace.git_captured",
    payload: { workspacePath: writerInput.workspacePath, commits: writer.commits, diffBytes: Buffer.byteLength(writer.diff, "utf8") }
  });
  await context.appendEvent({ taskId: writeTaskId, eventType: "writer.completed", payload: writer });
  await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [writeTaskId]);
  await pool.query(
    `INSERT INTO cost_records
     (task_id, run_id, project_id, cli, provider, model, input_tokens, output_tokens, cached_tokens,
      cost_usd, pricing_mode, cost_source, cost_source_raw)
     VALUES ($1, $2, $3, 'fake', 'fake', 'fake-writer', $4, $5, $6, 0,
             'opportunity_cost', 'opportunity_computed', $7::jsonb)`,
    [
      writeTaskId,
      context.runId,
      context.projectId,
      writer.tokenUsage.inputTokens,
      writer.tokenUsage.outputTokens,
      writer.tokenUsage.cachedTokens,
      JSON.stringify({ source: "hello-world fake adapter" })
    ]
  );

  const checkTaskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
     VALUES ($1, $2, 'check', 'Fake checker', 'done', 'ok', 'answerer', 'fake', 'fake-checker')`,
    [checkTaskId, context.runId]
  );
  const check = await fakeChecker.runAnswerer({ prompt: writer.diff, timeoutMs: 1_000 });
  await context.appendEvent({ taskId: checkTaskId, eventType: "checker.completed", payload: check });

  const auditTaskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
     VALUES ($1, $2, 'audit', 'Fake auditor', 'done', 'ok', 'answerer', 'fake', 'fake-auditor')`,
    [auditTaskId, context.runId]
  );
  const audit = await fakeAuditor.runAnswerer({ prompt: "Audit hello world", timeoutMs: 1_000 });
  await context.appendEvent({ taskId: auditTaskId, eventType: "auditor.completed", payload: audit });
}

async function markRunFailed(pool: pg.Pool, context: HelloWorkflowContext, error: unknown): Promise<void> {
  await pool.query("UPDATE runs SET outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
  await context.appendEvent({ eventType: "run.failed", payload: { message: messageFromError(error) } });
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
