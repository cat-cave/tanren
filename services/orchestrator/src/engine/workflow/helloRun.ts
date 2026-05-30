import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type JobEnvelope, type JobQueue, PgJobQueue } from "../contracts/jobQueue.js";
import { CostRecorder } from "../costs/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { fakeSelfHostedAuthRef } from "../providers/fake.js";
import { fakeAuditor, fakeChecker } from "../providers/fake.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { executePlanTask, executeStructuredAuditTask, executeStructuredCheckTask } from "./answererTasks.js";
import { recordHelloTaskCost } from "./helloCost.js";
import { executeWriteTask } from "./writerTasks.js";
import {
  allocateRunner,
  defaultRunnerImage,
  emitRoleFailed,
  emitRoleStarted,
  failureForTask,
  helloTaskDefinitions,
  markRunFailed,
  prepareWorkspace,
  proveRunnerSsh,
  type HelloExecutionState,
  type HelloJobPayload,
  type HelloRunnerProof,
  type HelloRunSummary,
  type HelloTaskDefinition,
  type HelloWorkflowContext,
  type HelloWorkflowDependencies,
} from "./helloRunSteps.js";

export type { HelloRunnerProof, HelloRunSummary, HelloWorkflowDependencies } from "./helloRunSteps.js";

export async function runHelloWorkflow(
  pool: pg.Pool,
  dependencies: HelloWorkflowDependencies,
): Promise<HelloRunSummary> {
  const projectId = `project_${randomUUID()}`;
  const specId = `spec_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const innerEventStore = dependencies.eventStore ?? new PgEventStore(pool);
  const jobQueue = dependencies.jobQueue ?? new PgJobQueue<HelloJobPayload>(pool);
  let eventCount = 0;
  // Counting wrapper so CostRecorder's cost.resolved events also tally toward
  // the summary count (P2A-0011).
  const eventStore: EventStore = {
    append: async (input) => {
      await innerEventStore.append(input);
      eventCount += 1;
    },
  };
  const context: HelloWorkflowContext = {
    runId,
    specId,
    projectId,
    appendEvent: (input) => eventStore.append({ runId, specId, projectId, ...input }),
  };

  const tasks = helloTaskDefinitions();
  await insertHelloRunRows(pool, {
    projectId,
    specId,
    runId,
    runnerImage: dependencies.runnerImage ?? defaultRunnerImage,
  });
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
        workspacePath,
        recorder: new CostRecorder(pool, eventStore),
      });
    } finally {
      await dependencies.allocator.release(allocation.runnerId);
      await context.appendEvent({
        eventType: "runner.released",
        payload: { runnerId: allocation.runnerId },
      });
    }
    if (runnerProof === undefined) {
      throw new Error("runner proof missing after successful SSH proof");
    }

    await pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [specId]);
    await pool.query(
      "UPDATE runs SET status = 'done', outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1",
      [runId],
    );
    await context.appendEvent({
      eventType: "run.completed",
      payload: { status: "done", outcome: "hello_world_complete" },
    });
    await context.appendEvent({
      eventType: "hello.completed",
      payload: { outcome: "hello_world_complete", runnerProof, workspacePath },
    });
    return {
      runId,
      specId,
      projectId,
      outcome: "hello_world_complete",
      events: eventCount,
      runnerProof,
    };
  } catch (error) {
    await markRunFailed(pool, context, jobQueue, error);
    throw error;
  }
}

// org_id is mandatory on every core table (tanren tenancy hardening). The
// hello fixture is a synthetic connectivity check that owns no real tenant, so
// it ensures a single deterministic fixture org exists and scopes its rows to
// it. Downstream rows derive org_id from the project so the chain stays
// internally consistent.
const HELLO_FIXTURE_ORG_ID = "org_hello_fixture";

async function insertHelloRunRows(
  pool: pg.Pool,
  input: { projectId: string; specId: string; runId: string; runnerImage: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'github_user', 'hello-fixture', 'hello-fixture', 'Hello Fixture')
     ON CONFLICT (id) DO NOTHING`,
    [HELLO_FIXTURE_ORG_ID],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, org_id)
     VALUES ($1, 'hello-world', 'https://github.com/cat-cave/tanren-fixture-easy', 'main', $2, 'local-docker', $3)`,
    [input.projectId, input.runnerImage, HELLO_FIXTURE_ORG_ID],
  );
  await pool.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, (SELECT org_id FROM projects WHERE project_id = $2), 'Hello world', 'Prove Tanren service connectivity', $3::jsonb, 'active')`,
    [input.specId, input.projectId, JSON.stringify(["A synthetic run completes and is visible"])],
  );
  await pool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, (SELECT org_id FROM projects WHERE project_id = $3), 'cli', 'tanren/hello-world', 'queued')`,
    [input.runId, input.specId, input.projectId],
  );
}

async function queueHelloTasks(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  tasks: HelloTaskDefinition[],
): Promise<void> {
  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), $3, $4, 'queued', $5, 'fake', $6)`,
      [task.taskId, context.runId, task.kind, task.title, task.agentKind, task.model],
    );
    const job = await jobQueue.enqueue({
      runId: context.runId,
      taskId: task.taskId,
      taskKind: task.kind,
      payload: { taskId: task.taskId, kind: task.kind },
      // RLS R3b: stamp the fixture org so the queue row carries its tenant.
      orgId: HELLO_FIXTURE_ORG_ID,
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "task.queued",
      payload: { taskKind: task.kind, jobId: job.id },
    });
  }
}

async function drainHelloQueue(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  jobQueue: JobQueue<HelloJobPayload>,
  tasks: HelloTaskDefinition[],
  state: HelloExecutionState,
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
  state: HelloExecutionState,
): Promise<void> {
  try {
    await pool.query("UPDATE tasks SET status = 'running', started_at = now() WHERE task_id = $1", [task.taskId]);
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "task.started",
      payload: { taskKind: task.kind, jobId: job.id },
    });
    await emitRoleStarted(context, task);
    await executeHelloTask(pool, context, task, state);
    await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [
      task.taskId,
    ]);
    await jobQueue.complete(job.id);
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "task.completed",
      payload: { taskKind: task.kind, jobId: job.id },
    });
  } catch (error) {
    const failure = failureForTask(task.kind, error);
    if (task.kind === "write") {
      await context.appendEvent({
        taskId: task.taskId,
        eventType: "workspace.failed",
        payload: { workspacePath: state.workspacePath, message: failure.message },
      });
    }
    await pool.query(
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
      [task.taskId, failure.kind],
    );
    await jobQueue.fail(job.id, failure);
    await emitRoleFailed(context, task, failure);
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "task.failed",
      payload: { taskKind: task.kind, jobId: job.id, ...failure },
    });
    throw error;
  }
}

async function executeHelloTask(
  pool: pg.Pool,
  context: HelloWorkflowContext,
  task: HelloTaskDefinition,
  state: HelloExecutionState,
): Promise<void> {
  if (task.kind === "plan") {
    state.planTitle = await executePlanTask();
    const plan = {
      subtasks: [
        {
          title: state.planTitle,
          acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
        },
      ],
    };
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "planner.completed",
      payload: plan,
    });
    return;
  }
  if (task.kind === "write") {
    state.writer = await executeWriteTask({
      allocation: state.allocation,
      prompt: state.planTitle ?? "Write hello world",
      ssh: state.ssh,
      timeoutMs: state.timeoutMs,
      workspacePath: state.workspacePath,
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "workspace.git_captured",
      payload: {
        workspacePath: state.workspacePath,
        commits: state.writer.commits,
        diffBytes: Buffer.byteLength(state.writer.diff, "utf8"),
      },
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "writer.completed",
      payload: state.writer,
    });
    await recordHelloTaskCost({
      recorder: state.recorder,
      scope: context,
      taskId: task.taskId,
      cli: "fake",
      model: "fake-writer",
      authRef: fakeSelfHostedAuthRef,
      tokenUsage: state.writer.tokenUsage,
    });
    return;
  }
  if (task.kind === "check") {
    state.check = await executeStructuredCheckTask(state.checkAnswerer, {
      specTitle: "Hello world",
      specDescription: "Prove Tanren service connectivity",
      acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
      writerDiff: state.writer?.diff ?? "",
      timeoutMs: state.timeoutMs,
    });
    await context.appendEvent({
      taskId: task.taskId,
      eventType: "checker.completed",
      payload: state.check,
    });
    await recordHelloTaskCost({
      recorder: state.recorder,
      scope: context,
      taskId: task.taskId,
      cli: state.checkAnswerer.cli,
      model: "fake-checker",
      authRef: state.checkAnswerer.authRef,
    });
    return;
  }
  const audit = await executeStructuredAuditTask(state.auditAnswerer, {
    specTitle: "Hello world",
    acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
    checkAnswer: state.check ?? {
      done: false,
      reason: "No checker answer was recorded.",
      suggested_fixes: ["Run checker first."],
    },
    writerDiff: state.writer?.diff ?? "",
    timeoutMs: state.timeoutMs,
  });
  await context.appendEvent({
    taskId: task.taskId,
    eventType: "auditor.completed",
    payload: audit,
  });
  await recordHelloTaskCost({
    recorder: state.recorder,
    scope: context,
    taskId: task.taskId,
    cli: state.auditAnswerer.cli,
    model: "fake-auditor",
    authRef: state.auditAnswerer.authRef,
  });
}
