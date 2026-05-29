/**
 * helloRunSteps — the runner/SSH/workspace step helpers and shared types for
 * the hello workflow. Extracted from helloRun.ts to keep both files under the
 * 500-line architecture cap. helloRun.ts owns the orchestration (queue drain,
 * run lifecycle); this module owns the discrete steps and the pure payload/
 * error helpers they share.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Allocator, RunnerAllocation } from "../contracts/allocator.js";
import type { JobQueue } from "../contracts/jobQueue.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import type { CostRecorder } from "../costs/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import { AnswererSchemaValidationError } from "../providers/codex.js";
import type { AuditAnswer, CheckAnswer } from "../providers/answererSchemas.js";
import type { AnswererAdapter, WriterResult } from "../providers/types.js";
import { prepareGitWorkspace } from "../workspace/index.js";

export const defaultRunnerImage = "ghcr.io/cat-cave/tanren-runner:v0";
export const defaultIdentitySecretRef = "runner/local-docker/identity";
export const runnerProofCommand = "printf 'tanren-hello-over-ssh\\n'";
export const expectedRunnerProofStdout = "tanren-hello-over-ssh\n";

export type HelloTaskKind = "plan" | "write" | "check" | "audit";

export interface HelloTaskDefinition {
  taskId: string;
  kind: HelloTaskKind;
  title: string;
  agentKind: "answerer" | "writer";
  model: string;
}

export interface HelloJobPayload {
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

export interface HelloWorkflowContext {
  runId: string;
  specId: string;
  projectId: string;
  appendEvent<N extends EventName>(input: { taskId?: string; eventType: N; payload: EventPayload<N> }): Promise<void>;
}

export interface HelloExecutionState {
  allocation: RunnerAllocation;
  ssh: SshSubstrate;
  timeoutMs: number;
  workspacePath: string;
  planTitle?: string;
  writer?: WriterResult;
  check?: CheckAnswer;
  checkAnswerer: AnswererAdapter<CheckAnswer>;
  auditAnswerer: AnswererAdapter<AuditAnswer>;
  recorder: CostRecorder;
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

export async function allocateRunner(
  context: HelloWorkflowContext,
  dependencies: HelloWorkflowDependencies,
): Promise<RunnerAllocation> {
  const runnerImage = dependencies.runnerImage ?? defaultRunnerImage;
  const identitySecretRef = dependencies.identitySecretRef ?? defaultIdentitySecretRef;
  const allocationRequest = {
    runId: context.runId,
    projectId: context.projectId,
    runnerImage,
    identitySecretRef,
  };

  await context.appendEvent({
    eventType: "allocator.requested",
    payload: { allocator: "local-docker", runnerImage, identitySecretRef },
  });

  try {
    const allocation = await dependencies.allocator.allocate(allocationRequest);
    await context.appendEvent({
      eventType: "allocator.allocated",
      payload: runnerAllocationPayload(allocation),
    });
    await context.appendEvent({
      eventType: "runner.allocated",
      payload: runnerAllocationPayload(allocation),
    });
    return allocation;
  } catch (error) {
    await context.appendEvent({
      eventType: "allocator.failed",
      payload: { message: messageFromError(error) },
    });
    throw error;
  }
}

export async function proveRunnerSsh(
  context: HelloWorkflowContext,
  dependencies: HelloWorkflowDependencies,
  allocation: RunnerAllocation,
): Promise<HelloRunnerProof> {
  await context.appendEvent({
    eventType: "hello.ssh_started",
    payload: {
      runnerId: allocation.runnerId,
      command: runnerProofCommand,
      target: runnerAllocationPayload(allocation).target,
    },
  });
  const result = await dependencies.ssh.run(allocation.target, {
    command: runnerProofCommand,
    timeoutMs: dependencies.sshTimeoutMs ?? 10_000,
  });
  if (result.failure !== undefined || result.exitCode !== 0 || result.stdout !== expectedRunnerProofStdout) {
    await context.appendEvent({
      eventType: "runner.failed",
      payload: { runnerId: allocation.runnerId, command: runnerProofCommand, result },
    });
    throw new Error(`hello SSH proof failed for ${allocation.runnerId}: ${runnerProofFailureText(result)}`);
  }
  const proof = runnerProofPayload(allocation, result);
  await context.appendEvent({ eventType: "hello.ssh_completed", payload: proof });
  return proof;
}

export async function prepareWorkspace(
  context: HelloWorkflowContext,
  dependencies: HelloWorkflowDependencies,
  allocation: RunnerAllocation,
  workspacePath: string,
): Promise<void> {
  try {
    await prepareGitWorkspace({
      ssh: dependencies.ssh,
      target: allocation.target,
      workspacePath,
      timeoutMs: dependencies.sshTimeoutMs ?? 10_000,
    });
    await context.appendEvent({
      eventType: "workspace.prepared",
      payload: { runnerId: allocation.runnerId, workspacePath },
    });
  } catch (error) {
    await context.appendEvent({
      eventType: "workspace.failed",
      payload: { runnerId: allocation.runnerId, workspacePath, message: messageFromError(error) },
    });
    throw error;
  }
}

export async function markRunFailed(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  error: unknown,
): Promise<void> {
  const failure = { kind: "run_failed", message: messageFromError(error) };
  const queuedTasks = await pool.query(
    `UPDATE tasks
     SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now()
     WHERE run_id = $1 AND status = 'queued'
     RETURNING task_id, kind`,
    [context.runId, failure.kind],
  );
  await jobQueue.failQueuedForRun(context.runId, failure);
  for (const task of queuedTasks.rows) {
    await context.appendEvent({
      taskId: String(task.task_id),
      eventType: "task.failed",
      payload: { taskKind: task.kind, ...failure },
    });
  }
  await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [
    context.runId,
  ]);
  await context.appendEvent({
    eventType: "run.failed",
    payload: { status: "failed", message: failure.message },
  });
}

export function helloTaskDefinitions(): HelloTaskDefinition[] {
  return [
    {
      taskId: `task_${randomUUID()}`,
      kind: "plan",
      title: "Fake planner",
      agentKind: "answerer",
      model: "fake-planner",
    },
    {
      taskId: `task_${randomUUID()}`,
      kind: "write",
      title: "Fake writer",
      agentKind: "writer",
      model: "fake-writer",
    },
    {
      taskId: `task_${randomUUID()}`,
      kind: "check",
      title: "Fake checker",
      agentKind: "answerer",
      model: "fake-checker",
    },
    {
      taskId: `task_${randomUUID()}`,
      kind: "audit",
      title: "Fake auditor",
      agentKind: "answerer",
      model: "fake-auditor",
    },
  ];
}

const roleStartedFor = {
  plan: "planner.started",
  write: "writer.started",
  check: "checker.started",
  audit: "auditor.started",
} as const;
const roleFailedFor = {
  plan: "planner.failed",
  write: "writer.failed",
  check: "checker.failed",
  audit: "auditor.failed",
} as const;

export async function emitRoleStarted(context: HelloWorkflowContext, task: HelloTaskDefinition): Promise<void> {
  await context.appendEvent({
    taskId: task.taskId,
    eventType: roleStartedFor[task.kind],
    payload: { taskKind: task.kind },
  });
}

export async function emitRoleFailed(
  context: HelloWorkflowContext,
  task: HelloTaskDefinition,
  failure: { kind: string; message: string },
): Promise<void> {
  await context.appendEvent({
    taskId: task.taskId,
    eventType: roleFailedFor[task.kind],
    payload: failure,
  });
}

export function failureForTask(kind: HelloTaskKind, error: unknown): { kind: string; message: string } {
  if (error instanceof AnswererSchemaValidationError) {
    return { kind: "schema_validation_failed", message: error.message };
  }
  return { kind: `${kind}_failed`, message: messageFromError(error) };
}

export function runnerAllocationPayload(allocation: RunnerAllocation) {
  return {
    runnerId: allocation.runnerId,
    imageSha: allocation.imageSha,
    target: {
      host: allocation.target.host,
      port: allocation.target.port,
      username: allocation.target.username,
      hostKeyFingerprint: allocation.target.hostKeyFingerprint,
    },
  };
}

export function runnerProofPayload(allocation: RunnerAllocation, result: SshCommandResult): HelloRunnerProof {
  return {
    ...runnerAllocationPayload(allocation),
    command: runnerProofCommand,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runnerProofFailureText(result: SshCommandResult): string {
  if (result.failure !== undefined) {
    return "message" in result.failure ? result.failure.message : result.failure.reason;
  }
  if (result.exitCode !== 0) {
    return `exit ${result.exitCode}`;
  }
  return `unexpected stdout ${JSON.stringify(result.stdout)}`;
}
