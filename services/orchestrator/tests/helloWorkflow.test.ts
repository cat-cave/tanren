import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { runHelloWorkflow } from "../src/engine/helloWorkflow.js";

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
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false }
    ]);
    const eventStore = new FakeEventStore();

    const summary = await runHelloWorkflow(pool.asPgPool(), {
      allocator,
      ssh,
      eventStore,
      identitySecretRef: "runner/test/identity",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
      sshTimeoutMs: 250
    });

    expect(allocator.requests).toEqual([
      {
        runId: summary.runId,
        projectId: summary.projectId,
        runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
        identitySecretRef: "runner/test/identity"
      }
    ]);
    const workspacePath = `/workspace/runs/${summary.runId}/repo`;
    expect(ssh.runs.map((run) => run.command.cwd)).toEqual([undefined, undefined, workspacePath, workspacePath, workspacePath]);
    expect(ssh.runs[0]).toEqual({
      target: allocator.allocation.target,
      command: { command: "printf 'tanren-hello-over-ssh\\n'", timeoutMs: 250 }
    });
    expect(ssh.runs[1]?.command.command).toContain(`mkdir -p '${workspacePath}'`);
    expect(ssh.runs[1]?.command.command).toContain("git init -b main");
    expect(ssh.runs[2]?.command.command).toContain("HELLO.md");
    expect(ssh.runs[3]?.command.command).toBe("git diff --no-color HEAD~1..HEAD");
    expect(ssh.runs[4]?.command.command).toBe("git log -1 --format='%H%x09%s' HEAD");
    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "hello.ssh_completed",
      "workspace.prepared",
      "planner.completed",
      "workspace.git_captured",
      "writer.completed",
      "checker.completed",
      "auditor.completed",
      "runner.released",
      "hello.completed"
    ]);
    expect(eventStore.events.find((event) => event.eventType === "workspace.prepared")?.payload).toEqual({
      runnerId: "runner_test",
      workspacePath
    });
    expect(eventStore.events.find((event) => event.eventType === "writer.completed")?.payload).toMatchObject({
      diff,
      commits: [{ sha, message: "hello world" }]
    });
    expect(pool.sql).toContain("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1");
    expect(summary.runnerProof).toMatchObject({
      runnerId: "runner_test",
      stdout: "tanren-hello-over-ssh\n",
      exitCode: 0
    });
    expect(summary.events).toBe(eventStore.events.length);
    expect(pool.sql).toContain("UPDATE runs SET outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1");
  });

  it("releases the runner and records failure when SSH proof fails", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([{ exitCode: 7, stdout: "", stderr: "nope", timedOut: false }]);
    const eventStore = new FakeEventStore();

    await expect(
      runHelloWorkflow(pool.asPgPool(), { allocator, ssh, eventStore, identitySecretRef: "runner/test/identity" })
    ).rejects.toThrow("hello SSH proof failed for runner_test: exit 7");

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "runner.failed",
      "runner.released",
      "run.failed"
    ]);
    expect(pool.sql).toContain("UPDATE runs SET outcome = 'failed', ended_at = now() WHERE run_id = $1");
  });

  it("rejects zero-exit SSH results with the wrong proof output", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([{ exitCode: 0, stdout: "wrong\n", stderr: "", timedOut: false }]);
    const eventStore = new FakeEventStore();

    await expect(
      runHelloWorkflow(pool.asPgPool(), { allocator, ssh, eventStore, identitySecretRef: "runner/test/identity" })
    ).rejects.toThrow('hello SSH proof failed for runner_test: unexpected stdout "wrong\\n"');

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "runner.failed",
      "runner.released",
      "run.failed"
    ]);
  });

  it("releases the runner and records failure when the fake writer SSH command fails", async () => {
    const pool = new FakePool();
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh([
      { exitCode: 0, stdout: "tanren-hello-over-ssh\n", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 9, stdout: "", stderr: "cannot write", timedOut: false }
    ]);
    const eventStore = new FakeEventStore();

    await expect(
      runHelloWorkflow(pool.asPgPool(), { allocator, ssh, eventStore, identitySecretRef: "runner/test/identity" })
    ).rejects.toThrow("fake writer mutation failed: exit 9");

    expect(allocator.releases).toEqual(["runner_test"]);
    expect(eventStore.events.map((event) => event.eventType)).toEqual([
      "hello.started",
      "allocator.requested",
      "allocator.allocated",
      "runner.allocated",
      "hello.ssh_started",
      "hello.ssh_completed",
      "workspace.prepared",
      "planner.completed",
      "workspace.failed",
      "writer.failed",
      "runner.released",
      "run.failed"
    ]);
    expect(pool.sql).toContain(
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = 'workspace_failed', ended_at = now() WHERE task_id = $1"
    );
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
      identitySecretRef: "runner/test/identity"
    }
  };

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.requests.push(request);
    return { ...this.allocation, target: { ...this.allocation.target, identitySecretRef: request.identitySecretRef } };
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
