import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { fakeAuditor, fakeChecker } from "./fixtures/fakeAnswerers.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import { runPhase1FixtureWorkflow, type Phase1FixtureRunContext } from "../src/engine/workflow/phase1Fixture.js";

describe("phase 1 end-to-end fixture workflow", () => {
  it("runs writer, structured checks, draft PR publication, and CI polling as one persisted fixture", async () => {
    const context: Phase1FixtureRunContext = {
      runId: "run_phase1_fixture",
      specId: "spec_phase1_fixture",
      projectId: "project_phase1_fixture",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      targetBranch: "main",
      runBranch: "tanren/phase1-fixture",
      specTitle: "Add fixture marker",
      specDescription: "Add a deterministic Tanren fixture marker file.",
      acceptanceCriteria: ["PHASE1_FIXTURE.md contains tanren phase 1 ok"],
      runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "credential/github/dev",
    };
    const pool = new FixturePool(context);
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: context.githubCredentialRef, token: "ghp_secretToken" });
    const allocator = new RecordingAllocator();
    const ssh = new RecordingSsh();
    const github = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 42,
          html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/42",
          draft: true,
          base: { ref: "main" },
        },
      },
      {
        status: 200,
        body: {
          head: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", ref: "tanren/phase1-fixture" },
        },
      },
      {
        status: 200,
        body: {
          check_runs: [
            {
              name: "check",
              status: "completed",
              conclusion: "success",
              html_url: "https://ci.example/check",
            },
          ],
        },
      },
      { status: 200, body: { statuses: [] } },
    ]);

    const result = await runPhase1FixtureWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      vcsProvider: vcsProviderOver(github),
      context,
      createWriter: () => fakeWriter,
      createChecker: () => fakeChecker,
      createAuditor: () => fakeAuditor,
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
    });

    expect(result.pullRequest.prNumber).toBe(42);
    expect(result.ci.status).toBe("passed");
    expect(pool.runStatus).toEqual({ status: "done", outcome: "phase1_fixture_complete" });
    expect(pool.prUrl).toBe("https://github.com/cat-cave/tanren-fixture-easy/pull/42");
    expect(allocator.requests).toEqual([
      {
        runId: context.runId,
        projectId: context.projectId,
        runnerImage: context.runnerImage,
        identitySecretRef: context.identitySecretRef,
      },
    ]);
    expect(ssh.commands[0]?.command.command).toContain("git clone --depth 1");
    expect(events.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "phase1.fixture.started",
        "writer.completed",
        "checker.completed",
        "auditor.completed",
        "github.pr.created",
        "ci.passed",
        "phase1.fixture.completed",
      ]),
    );
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
    expect(JSON.stringify(github.requests)).not.toContain("ghp_secretToken");
    expect(ssh.commands.map((item) => item.command.command).join("\n")).not.toContain("ghp_secretToken");
  });
});

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const fakeWriterResult: WriterResult = {
  diff: "diff --git a/PHASE1_FIXTURE.md b/PHASE1_FIXTURE.md\n+tanren phase 1 ok\n",
  commits: [{ sha: "ffffffffffffffffffffffffffffffffffffffff", message: "phase 1 fixture" }],
  exitReason: "completed",
  tokenUsage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
  },
};

const fakeWriter: WriterAdapter = {
  kind: "writer",
  cli: "fake",
  authRef: "credential/self-hosted/phase1-fixture-test",
  async runWriter() {
    return fakeWriterResult;
  },
};

class RecordingAllocator implements Allocator {
  readonly requests: AllocationRequest[] = [];
  readonly releases: string[] = [];

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.requests.push(request);
    return { runnerId: "runner_phase1", imageSha: "sha256:phase1", target };
  }

  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

class FixturePool {
  prUrl: string | null = null;
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  private ciTask: { taskId: string; attempt: number } | undefined;

  constructor(private readonly context: Phase1FixtureRunContext) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.pr_url")) {
      return {
        rows: [
          {
            run_id: this.context.runId,
            spec_id: this.context.specId,
            project_id: this.context.projectId,
            pr_url: this.prUrl,
            config: { githubCredentialRef: this.context.githubCredentialRef },
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT task_id, attempt")) {
      return {
        rows: this.ciTask === undefined ? [] : [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }],
        rowCount: this.ciTask === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("INSERT INTO tasks") && sql.includes("'ci'")) {
      this.ciTask = { taskId: String(params[0]), attempt: 1 };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE runs SET pr_url")) {
      this.prUrl = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE runs SET status = 'done'")) {
      this.runStatus = { status: "done", outcome: "phase1_fixture_complete" };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE runs SET status = 'failed'")) {
      this.runStatus = { status: "failed", outcome: "failed" };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  asPgPool() {
    return this as never;
  }
}
