import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { fakeAuditor, fakeChecker } from "../src/engine/providers/fake.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import { runPhase1FixtureWorkflow, type Phase1FixtureRunContext } from "../src/engine/workflow/phase1Fixture.js";

// Integration test: the Phase 1 fixture workflow must persist one cost_records
// row per completed planner/writer/checker/auditor task with the full typed
// token breakdown. Cost is best-effort — fake self-hosted adapters record
// cost_usd = NULL / cost_basis = 'unknown' and the run still completes.

describe("phase 1 fixture cost-record persistence", () => {
  it("writes one cost_records row per task with a cost basis and emits cost.resolved events", async () => {
    const context: Phase1FixtureRunContext = {
      runId: "run_p2a_0011_phase1",
      specId: "spec_p2a_0011_phase1",
      projectId: "project_p2a_0011_phase1",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      targetBranch: "main",
      runBranch: "tanren/p2a-0011-phase1",
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

    const result = await runPhase1FixtureWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator: new RecordingAllocator(),
      ssh: new RecordingSsh(),
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: [] },
        {
          status: 201,
          body: {
            number: 7,
            html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/7",
            draft: true,
            base: { ref: "main" },
          },
        },
        {
          status: 200,
          body: {
            head: {
              sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              ref: "tanren/p2a-0011-phase1",
            },
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
      ]),
      context,
      createWriter: () => fakeWriter,
      createChecker: () => fakeChecker,
      createAuditor: () => fakeAuditor,
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
    });

    expect(result.ci.status).toBe("passed");
    // write, check, audit
    expect(pool.costInserts).toHaveLength(3);
    // Insert columns: ...billing_mode($14), cost_basis($15) → 0-based 13, 14.
    const billingModes = pool.costInserts.map((row) => String(row.params[13]));
    const costBases = pool.costInserts.map((row) => String(row.params[14]));
    expect(billingModes).toEqual(["self_hosted", "self_hosted", "self_hosted"]);
    expect(costBases).toEqual(["unknown", "unknown", "unknown"]);
    // cost_usd is NULL for self-hosted (best-effort, no fake estimate).
    expect(pool.costInserts.map((row) => row.params[12])).toEqual([null, null, null]);
    const costRecorded = events.events.filter((event) => event.eventType === "cost.resolved");
    expect(costRecorded).toHaveLength(3);
    expect(
      costRecorded.every((event) => event.payload && (event.payload as { costBasis: string }).costBasis !== ""),
    ).toBe(true);
    const allInsertText = JSON.stringify(pool.costInserts);
    expect(allInsertText).not.toContain("unknown_source");
    const forbiddenPlaceholder = ["legacy", "unknown"].join("_");
    expect(allInsertText).not.toContain(forbiddenPlaceholder);
  });

  it("records an unattributable adapter ref as cost_usd NULL / cost_basis 'unknown' WITHOUT failing the run", async () => {
    const context: Phase1FixtureRunContext = {
      runId: "run_cost_unknown_ok",
      specId: "spec_cost_unknown_ok",
      projectId: "project_cost_unknown_ok",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      targetBranch: "main",
      runBranch: "tanren/cost-unknown-ok",
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
    // An auth ref that matches no rule resolves to unknown billing — cost is
    // unknown, but the run must NOT fail (token accounting still lands).
    const unattributableWriter: WriterAdapter = {
      kind: "writer",
      cli: "fake",
      authRef: "vault/secret/legacy/something",
      async runWriter() {
        return fakeWriterResult;
      },
    };
    const result = await runPhase1FixtureWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator: new RecordingAllocator(),
      ssh: new RecordingSsh(),
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: [] },
        {
          status: 201,
          body: {
            number: 9,
            html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/9",
            draft: true,
            base: { ref: "main" },
          },
        },
        {
          status: 200,
          body: {
            head: {
              sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              ref: "tanren/cost-unknown-ok",
            },
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
      ]),
      context,
      createWriter: () => unattributableWriter,
      createChecker: () => fakeChecker,
      createAuditor: () => fakeAuditor,
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
    });
    expect(result.ci.status).toBe("passed");
    expect(events.events.some((event) => event.eventType === "phase1.fixture.failed")).toBe(false);
    // The writer cost row still lands with cost unknown.
    const writerInsert = pool.costInserts[0];
    // cost_usd
    expect(writerInsert?.params[12]).toBeNull();
    // cost_basis
    expect(String(writerInsert?.params[14])).toBe("unknown");
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
    inputTokens: 4,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 6,
  },
};

const fakeWriter: WriterAdapter = {
  kind: "writer",
  cli: "fake",
  authRef: "credential/self-hosted/p2a-0011-test",
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

interface CapturedInsert {
  table: string;
  params: ReadonlyArray<unknown>;
}

class FixturePool {
  prUrl: string | null = null;
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  readonly costInserts: CapturedInsert[] = [];
  private ciTask: { taskId: string; attempt: number } | undefined;

  constructor(private readonly context: Phase1FixtureRunContext) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costInserts.push({ table: "cost_records", params });
      return { rows: [], rowCount: 1 };
    }
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
