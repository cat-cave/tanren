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

// Integration test for P2A-0011: the Phase 1 fixture workflow must persist
// one cost_records row per completed planner/writer/checker/auditor task with
// an explicit cost source, no `unknown_source` fallback.

describe("phase 1 fixture cost-record persistence (P2A-0011)", () => {
  it("writes one cost_records row per task with attributed source and emits cost.resolved events", async () => {
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
      githubCredentialRef: "credential/github/dev"
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
        { status: 201, body: { number: 7, html_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/7", draft: true, base: { ref: "main" } } },
        { status: 200, body: { head: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", ref: "tanren/p2a-0011-phase1" } } },
        { status: 200, body: { check_runs: [{ name: "check", status: "completed", conclusion: "success", html_url: "https://ci.example/check" }] } },
        { status: 200, body: { statuses: [] } }
      ]),
      context,
      createWriter: () => fakeWriter,
      createChecker: () => fakeChecker,
      createAuditor: () => fakeAuditor,
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => undefined
    });

    expect(result.ci.status).toBe("passed");
    expect(pool.costInserts).toHaveLength(3); // write, check, audit
    const costSources = pool.costInserts.map((row) => String(row.params[11]));
    expect(costSources).toEqual(["opportunity_computed", "opportunity_computed", "opportunity_computed"]);
    const costRecorded = events.events.filter((event) => event.eventType === "cost.resolved");
    expect(costRecorded).toHaveLength(3);
    expect(costRecorded.every((event) => event.payload && (event.payload as { costSource: string }).costSource !== "")).toBe(true);
    // No placeholder source ever lands in the persisted column (per AGENTS.md
    // brief invariant: cost records use only the three v0 cost sources).
    const allInsertText = JSON.stringify(pool.costInserts);
    expect(allInsertText).not.toContain("unknown_source");
    const forbiddenPlaceholder = ["legacy", "unknown"].join("_");
    expect(allInsertText).not.toContain(forbiddenPlaceholder);
  });

  it("fails the writer task with failureKind='cost.unattributable' when the adapter ref does not match any rule", async () => {
    const context: Phase1FixtureRunContext = {
      runId: "run_p2a_0011_unattributable",
      specId: "spec_p2a_0011_unattributable",
      projectId: "project_p2a_0011_unattributable",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      targetBranch: "main",
      runBranch: "tanren/p2a-0011-unattributable",
      specTitle: "Add fixture marker",
      specDescription: "irrelevant",
      acceptanceCriteria: ["irrelevant"],
      runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "credential/github/dev"
    };
    const pool = new FixturePool(context);
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: context.githubCredentialRef, token: "ghp_secretToken" });
    const unattributableWriter: WriterAdapter = {
      kind: "writer",
      cli: "fake",
      // Intentionally not a known credential prefix — must escape-hatch the run.
      authRef: "vault/secret/legacy/something",
      async runWriter() {
        return fakeWriterResult;
      }
    };
    await expect(
      runPhase1FixtureWorkflow({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator: new RecordingAllocator(),
        ssh: new RecordingSsh(),
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context,
        createWriter: () => unattributableWriter,
        createChecker: () => fakeChecker,
        createAuditor: () => fakeAuditor,
        timeoutMs: 100,
        maxCiPolls: 1,
        sleep: async () => undefined
      })
    ).rejects.toThrow(/cost\.unattributable/);
    expect(events.events.some((event) => event.eventType === "cost.unattributable")).toBe(true);
    expect(events.events.some((event) => event.eventType === "writer.failed")).toBe(true);
    expect(events.events.some((event) => event.eventType === "phase1.fixture.failed")).toBe(true);
    expect(pool.costInserts).toHaveLength(0);
  });
});

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity"
};

const fakeWriterResult: WriterResult = {
  diff: "diff --git a/PHASE1_FIXTURE.md b/PHASE1_FIXTURE.md\n+tanren phase 1 ok\n",
  commits: [{ sha: "ffffffffffffffffffffffffffffffffffffffff", message: "phase 1 fixture" }],
  exitReason: "completed",
  tokenUsage: { inputTokens: 4, outputTokens: 2, cachedTokens: 0 }
};

const fakeWriter: WriterAdapter = {
  kind: "writer",
  cli: "fake",
  authRef: "credential/self-hosted/p2a-0011-test",
  async runWriter() {
    return fakeWriterResult;
  }
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
  readonly denominatorRows = new Map<string, number>();
  private ciTask: { taskId: string; attempt: number } | undefined;

  constructor(private readonly context: Phase1FixtureRunContext) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costInserts.push({ table: "cost_records", params });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT observed_max_monthly_tokens")) {
      const value = this.denominatorRows.get(String(params[0]));
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ observed_max_monthly_tokens: value }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT COALESCE(SUM(input_tokens")) {
      return { rows: [{ total: "0" }], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO subscription_window_denominators")) {
      this.denominatorRows.set(String(params[0]), Number(params[1]));
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
            config: { githubCredentialRef: this.context.githubCredentialRef }
          }
        ],
        rowCount: 1
      };
    }
    if (sql.startsWith("SELECT task_id, attempt")) {
      return { rows: this.ciTask === undefined ? [] : [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }], rowCount: this.ciTask === undefined ? 0 : 1 };
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
