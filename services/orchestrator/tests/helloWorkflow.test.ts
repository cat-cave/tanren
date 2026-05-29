import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import type { JobEnvelope, JobQueue } from "../src/engine/contracts/jobQueue.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import type { CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import { parseStructuredAnswererOutput } from "../src/engine/providers/codex.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { runHelloWorkflow } from "../src/engine/workflow/helloRun.js";

describe("hello workflow", () => {
  it("allocates a runner, proves SSH, writes in a git workspace, captures metadata, and releases it", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const sha = "cccccccccccccccccccccccccccccccccccccccc";
    const diff = "diff --git a/HELLO.md b/HELLO.md\nnew file mode 100644\n+hello world\n";
    const ssh = new RecordingSsh([
      { exitCode: 0, stdout: "tanren-hello-over-ssh\n", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: diff, stderr: "", timedOut: false },
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false },
    ]);
    const eventStore = new FakeEventStore();
    const jobQueue = new RecordingJobQueue();

    const summary = await runHelloWorkflow(pool.asPgPool(), {
      allocator,
      ssh,
      eventStore,
      jobQueue,
      identitySecretRef: "runner/test/identity",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
      sshTimeoutMs: 250,
    });

    expect(allocator.requests).toEqual([
      {
        runId: summary.runId,
        projectId: summary.projectId,
        runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
        identitySecretRef: "runner/test/identity",
      },
    ]);
    const workspacePath = `/workspace/runs/${summary.runId}/repo`;
    expect(ssh.runs.map((run) => run.command.cwd)).toEqual([
      undefined,
      undefined,
      workspacePath,
      workspacePath,
      workspacePath,
    ]);
    expect(ssh.runs[0]).toEqual({
      target: allocator.allocation.target,
      command: { command: "printf 'tanren-hello-over-ssh\\n'", timeoutMs: 250 },
    });
    expect(ssh.runs[1]?.command.command).toContain(`mkdir -p '${workspacePath}'`);
    expect(ssh.runs[1]?.command.command).toContain("git init -b main");
    expect(ssh.runs[2]?.command.command).toContain("HELLO.md");
    expect(ssh.runs[3]?.command.command).toBe("git diff --no-color HEAD~1..HEAD");
    expect(ssh.runs[4]?.command.command).toBe("git log -1 --format='%H%x09%s' HEAD");
    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "task.queued",
      "task.queued",
      "task.queued",
      "task.queued",
      "run.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "hello.ssh_completed",
      "workspace.prepared",
      "task.started",
      "planner.started",
      "planner.completed",
      "task.completed",
      "task.started",
      "writer.started",
      "workspace.git_captured",
      "writer.completed",
      "cost.resolved",
      "task.completed",
      "task.started",
      "checker.started",
      "checker.completed",
      "cost.resolved",
      "task.completed",
      "task.started",
      "auditor.started",
      "auditor.completed",
      "cost.resolved",
      "task.completed",
      "runner.released",
      "run.completed",
      "hello.completed",
    ]);
    expect(jobQueue.enqueues.map((job) => job.taskKind)).toEqual(["plan", "write", "check", "audit"]);
    expect(jobQueue.claims.map((claim) => claim.taskKind)).toEqual(["plan", "write", "check", "audit"]);
    expect(jobQueue.completions).toHaveLength(4);
    expect(eventStore.events.find((event) => event.eventType === "workspace.prepared")?.payload).toEqual({
      runnerId: "runner_test",
      workspacePath,
    });
    expect(eventStore.events.find((event) => event.eventType === "writer.completed")?.payload).toMatchObject({
      diff,
      commits: [{ sha, message: "hello world" }],
    });
    expect(pool.sql.filter((sql) => sql.includes("INSERT INTO tasks"))).toHaveLength(4);
    expect(pool.sql.filter((sql) => sql.includes("UPDATE tasks SET status = 'running'"))).toHaveLength(4);
    expect(pool.sql.filter((sql) => sql.includes("UPDATE tasks SET status = 'done'"))).toHaveLength(4);
    expect(summary.runnerProof).toMatchObject({
      runnerId: "runner_test",
      stdout: "tanren-hello-over-ssh\n",
      exitCode: 0,
    });
    expect(summary.events).toBe(eventStore.events.length);
    expect(pool.sql).toContain(
      "UPDATE runs SET status = 'done', outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1",
    );
  });

  it("releases the runner and records failure when SSH proof fails", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([{ exitCode: 7, stdout: "", stderr: "nope", timedOut: false }]);
    const eventStore = new FakeEventStore();
    const jobQueue = new RecordingJobQueue();

    await expect(
      runHelloWorkflow(pool.asPgPool(), {
        allocator,
        ssh,
        eventStore,
        jobQueue,
        identitySecretRef: "runner/test/identity",
      }),
    ).rejects.toThrow("hello SSH proof failed for runner_test: exit 7");

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "task.queued",
      "task.queued",
      "task.queued",
      "task.queued",
      "run.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "runner.failed",
      "runner.released",
      "run.failed",
    ]);
    expect(jobQueue.claims).toEqual([]);
    expect(jobQueue.queuedRunFailures).toEqual([
      {
        runId: expect.stringMatching(/^run_/) as string,
        failure: { kind: "run_failed", message: "hello SSH proof failed for runner_test: exit 7" },
      },
    ]);
    expect(pool.sql).toContain(
      "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
    );
    expect(pool.sql).toContain(
      "UPDATE tasks\n     SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now()\n     WHERE run_id = $1 AND status = 'queued'\n     RETURNING task_id, kind",
    );
  });

  it("rejects zero-exit SSH results with the wrong proof output", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([{ exitCode: 0, stdout: "wrong\n", stderr: "", timedOut: false }]);
    const eventStore = new FakeEventStore();
    const jobQueue = new RecordingJobQueue();

    await expect(
      runHelloWorkflow(pool.asPgPool(), {
        allocator,
        ssh,
        eventStore,
        jobQueue,
        identitySecretRef: "runner/test/identity",
      }),
    ).rejects.toThrow('hello SSH proof failed for runner_test: unexpected stdout "wrong\\n"');

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "task.queued",
      "task.queued",
      "task.queued",
      "task.queued",
      "run.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "runner.failed",
      "runner.released",
      "run.failed",
    ]);
    expect(jobQueue.claims).toEqual([]);
    expect(jobQueue.queuedRunFailures).toEqual([
      {
        runId: expect.stringMatching(/^run_/) as string,
        failure: {
          kind: "run_failed",
          message: 'hello SSH proof failed for runner_test: unexpected stdout "wrong\\n"',
        },
      },
    ]);
  });

  it("releases the runner and records failure when the fake writer SSH command fails", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([
      { exitCode: 0, stdout: "tanren-hello-over-ssh\n", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 9, stdout: "", stderr: "cannot write", timedOut: false },
    ]);
    const eventStore = new FakeEventStore();
    const jobQueue = new RecordingJobQueue();

    await expect(
      runHelloWorkflow(pool.asPgPool(), {
        allocator,
        ssh,
        eventStore,
        jobQueue,
        identitySecretRef: "runner/test/identity",
      }),
    ).rejects.toThrow("fake writer mutation failed: exit 9");

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "task.queued",
      "task.queued",
      "task.queued",
      "task.queued",
      "run.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "hello.ssh_completed",
      "workspace.prepared",
      "task.started",
      "planner.started",
      "planner.completed",
      "task.completed",
      "task.started",
      "writer.started",
      "workspace.failed",
      "writer.failed",
      "task.failed",
      "runner.released",
      "run.failed",
    ]);
    expect(jobQueue.failures).toEqual([
      {
        id: "job_2",
        failure: { kind: "write_failed", message: "fake writer mutation failed: exit 9" },
      },
    ]);
    expect(jobQueue.queuedRunFailures).toEqual([
      {
        runId: expect.stringMatching(/^run_/) as string,
        failure: { kind: "run_failed", message: "fake writer mutation failed: exit 9" },
      },
    ]);
    expect(pool.sql).toContain(
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
    );
  });

  it("records structured Answerer parse failures as schema validation failures", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const sha = "dddddddddddddddddddddddddddddddddddddddd";
    const ssh = new RecordingSsh([
      { exitCode: 0, stdout: "tanren-hello-over-ssh\n", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      {
        exitCode: 0,
        stdout: "diff --git a/HELLO.md b/HELLO.md\n+hello world\n",
        stderr: "",
        timedOut: false,
      },
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false },
    ]);
    const eventStore = new FakeEventStore();
    const jobQueue = new RecordingJobQueue();
    const badChecker: AnswererAdapter<CheckAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/hello-workflow-test",
      async runAnswerer(opts) {
        return parseStructuredAnswererOutput("not-json", opts.outputSchema);
      },
    };

    await expect(
      runHelloWorkflow(pool.asPgPool(), {
        allocator,
        ssh,
        eventStore,
        jobQueue,
        identitySecretRef: "runner/test/identity",
        checkAnswerer: badChecker,
      }),
    ).rejects.toThrow("Answerer response failed tanren.check_answer.v1 validation");

    expect(jobQueue.failures).toEqual([
      {
        id: "job_3",
        failure: {
          kind: "schema_validation_failed",
          message: expect.stringContaining("Answerer response failed tanren.check_answer.v1 validation") as string,
        },
      },
    ]);
    expect(eventStore.events.find((event) => event.eventType === "checker.failed")?.payload).toMatchObject({
      kind: "schema_validation_failed",
    });
  });
});

class FakePool {
  readonly sql: string[] = [];

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.sql.push(sql);
    return { rows: [], rowCount: 1 };
  }

  asPgPool() {
    return this as never;
  }
}

class RecordingAllocator implements Allocator {
  readonly requests: AllocationRequest[] = [];
  readonly releases: string[] = [];
  readonly allocation: RunnerAllocation = {
    runnerId: "runner_test",
    imageSha: "sha256:runner-test",
    target: {
      host: "runner",
      port: 22,
      username: "tanren",
      hostKeyFingerprint: "SHA256:runner-host",
      identitySecretRef: "runner/test/identity",
    },
  };

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.requests.push(request);
    return {
      ...this.allocation,
      target: { ...this.allocation.target, identitySecretRef: request.identitySecretRef },
    };
  }

  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

class RecordingSsh implements SshSubstrate {
  readonly runs: Array<{ target: SshTarget; command: SshCommand }> = [];

  constructor(private readonly results: SshCommandResult[]) {}

  async run(target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.runs.push({ target, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}

class RecordingJobQueue<TPayload = { taskId: string; kind: string }> implements JobQueue<TPayload> {
  readonly enqueues: Array<Omit<JobEnvelope<TPayload>, "id" | "attempts">> = [];
  readonly claims: Array<{ taskKind: string; runId?: string }> = [];
  readonly completions: string[] = [];
  readonly failures: Array<{ id: string; failure: { kind: string; message: string } }> = [];
  readonly queuedRunFailures: Array<{ runId: string; failure: { kind: string; message: string } }> = [];
  private readonly jobs: Array<JobEnvelope<TPayload> & { status: "queued" | "running" | "done" | "failed" }> = [];

  async enqueue(
    job: Omit<JobEnvelope<TPayload>, "id" | "attempts"> & { attempts?: number },
  ): Promise<JobEnvelope<TPayload>> {
    this.enqueues.push(job);
    const envelope = {
      ...job,
      id: `job_${this.jobs.length + 1}`,
      attempts: job.attempts ?? 0,
      status: "queued" as const,
    };
    this.jobs.push(envelope);
    return envelope;
  }

  async claim(taskKind: string, options?: { runId?: string }): Promise<JobEnvelope<TPayload> | undefined> {
    this.claims.push({ taskKind, runId: options?.runId });
    const job = this.jobs.find(
      (candidate) =>
        candidate.status === "queued" && candidate.taskKind === taskKind && matchesRun(candidate.runId, options?.runId),
    );
    if (job === undefined) {
      return undefined;
    }
    job.status = "running";
    job.attempts += 1;
    return job;
  }

  async complete(id: string): Promise<void> {
    this.completions.push(id);
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "done";
    }
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    this.failures.push({ id, failure });
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "failed";
    }
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    this.queuedRunFailures.push({ runId, failure });
    for (const job of this.jobs) {
      if (job.status === "queued" && job.runId === runId) {
        job.status = "failed";
      }
    }
  }
}

function matchesRun(jobRunId: string | undefined, requestedRunId: string | undefined): boolean {
  return requestedRunId === undefined || jobRunId === requestedRunId;
}
