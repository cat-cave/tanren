import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import {
  FetchGitHubHttpClient,
  type GitHubHttpClient,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  parseGitHubPullRequestUrl
} from "../src/engine/providers/github.js";
import { computeCiRetryDelayMs, evaluateCiObservation, pollCiForRun } from "../src/engine/workflow/ciPolling.js";
import { buildApp } from "../src/main.js";

describe("CI polling loop", () => {
  it("parses GitHub PR URLs and classifies pending, passing, and failing checks", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/cat-cave/tanren-fixture-easy/pull/1")).toEqual({
      repo: { owner: "cat-cave", name: "tanren-fixture-easy" },
      pullNumber: 1
    });
    expect(() => parseGitHubPullRequestUrl("https://example.com/cat-cave/repo/pull/1")).toThrow("unsupported GitHub");

    expect(evaluateCiObservation({ head: { sha: "abc" }, checkRuns: [], statuses: [] })).toMatchObject({
      status: "pending",
      reason: "no_checks"
    });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [{ context: "legacy", state: "success" }]
      })
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "in_progress" }],
        statuses: []
      })
    ).toMatchObject({ status: "pending", reason: "checks_pending" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "timed_out" }],
        statuses: [{ context: "legacy", state: "success" }]
      })
    ).toMatchObject({ status: "failed", reason: "check_failed" });
  });

  it("gates on required branch-protection checks only (P3-0028)", () => {
    // A required check that hasn't reported yet keeps the run pending even
    // though every OBSERVED check is green.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [],
        requiredContexts: ["build", "e2e"]
      })
    ).toMatchObject({ status: "pending", reason: "checks_pending" });

    // An OPTIONAL check failing does not block when it isn't required.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint-optional", status: "completed", conclusion: "failure" }
        ],
        statuses: [],
        requiredContexts: ["build"]
      })
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });

    // A REQUIRED check failing fails the run.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
        requiredContexts: ["build"]
      })
    ).toMatchObject({ status: "failed", reason: "check_failed" });

    // All required contexts present + green → passed.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "e2e", status: "completed", conclusion: "success" }
        ],
        statuses: [],
        requiredContexts: ["build", "e2e"]
      })
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("computes bounded retry backoff for pending CI observations", () => {
    expect(computeCiRetryDelayMs(1)).toBe(5_000);
    expect(computeCiRetryDelayMs(2)).toBe(10_000);
    expect(computeCiRetryDelayMs(4)).toBe(40_000);
    expect(computeCiRetryDelayMs(99)).toBe(60_000);
  });

  it("persists pending CI state without leaking GitHub tokens", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const http = new ScriptedGitHubHttp([
      { status: 200, body: { head: { sha: "abc123", ref: "tanren/run_1" } } },
      { status: 200, body: { check_runs: [] } },
      { status: 200, body: { statuses: [] } }
    ]);

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      githubHttp: http,
      runId: "run_1"
    });

    expect(result).toMatchObject({
      runId: "run_1",
      status: "pending",
      reason: "no_checks",
      headSha: "abc123",
      nextPollAfterMs: 5_000,
      summary: { checkRuns: 0, statuses: 0, failing: 0, pending: 0 }
    });
    expect(pool.tasks[0]).toMatchObject({ run_id: "run_1", kind: "ci", status: "running", outcome: "pending", attempt: 1 });
    expect(events.events.map((event) => event.eventType)).toEqual(["task.started", "ci.started"]);
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
    expect(JSON.stringify(http.requests)).not.toContain("ghp_secretToken");
  });

  it("persists passing and failing CI outcomes as inspectable task state", async () => {
    const passPool = new CiMemoryPool();
    const passEvents = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });

    await pollCiForRun({
      pool: passPool.asPgPool(),
      eventStore: passEvents,
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: { head: { sha: "pass123" } } },
        { status: 200, body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] } },
        { status: 200, body: { statuses: [{ context: "legacy", state: "success" }] } }
      ]),
      runId: "run_1"
    });

    expect(passPool.tasks[0]).toMatchObject({ kind: "ci", status: "done", outcome: "ok" });
    expect(passEvents.events.map((event) => event.eventType)).toEqual(["task.started", "ci.passed", "task.completed"]);

    const failPool = new CiMemoryPool();
    const failEvents = new FakeEventStore();
    await pollCiForRun({
      pool: failPool.asPgPool(),
      eventStore: failEvents,
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: { head: { sha: "fail123" } } },
        { status: 200, body: { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] } },
        { status: 200, body: { statuses: [] } }
      ]),
      runId: "run_1"
    });

    expect(failPool.tasks[0]).toMatchObject({ kind: "ci", status: "failed", outcome: "failed", failure_kind: "ci_failed" });
    expect(failEvents.events.map((event) => event.eventType)).toEqual(["task.started", "ci.failed", "task.failed"]);
  });

  it("exposes CI polling through the API and tanren status run details", async () => {
    const pool = new CiMemoryPool();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const app = buildApp({
      pool: pool.asPgPool(),
      helloDependencies: {} as never,
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: { head: { sha: "abc123" } } },
        { status: 200, body: { check_runs: [] } },
        { status: 200, body: { statuses: [] } }
      ]),
      vaultHealthCheck: async () => ({ ok: true, status: 200 })
    });

    const pollResponse = await app.request("/runs/run_1/ci/poll", { method: "POST" });
    expect(pollResponse.status).toBe(200);
    await expect(pollResponse.json()).resolves.toMatchObject({ status: "pending", reason: "no_checks" });

    const statusResponse = await app.request("/runs/run_1");
    const status = await statusResponse.json();
    expect(status.tasks).toEqual([expect.objectContaining({ kind: "ci", status: "running", outcome: "pending" })]);
    expect(status.events).toEqual([
      expect.objectContaining({ event_type: "task.started" }),
      expect.objectContaining({ event_type: "ci.started" })
    ]);
    expect(JSON.stringify(status)).not.toContain("ghp_secretToken");
  });
});

const liveGithubTokenFile = process.env.TANREN_GITHUB_TOKEN_FILE;

describe("live CI polling fixture", () => {
  it("observes the fixture PR head when TANREN_GITHUB_TOKEN_FILE is set", async () => {
    if (liveGithubTokenFile === undefined) {
      return;
    }
    expect.hasAssertions();
    const pool = new CiMemoryPool();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: await readFile(liveGithubTokenFile, "utf8") });

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: new FakeEventStore(),
      secrets,
      githubHttp: new FetchGitHubHttpClient(),
      runId: "run_1"
    });

    expect(["pending", "passed", "failed"]).toContain(result.status);
  });
});

const eventsTableName = ["events"].join("");

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

class CiMemoryPool {
  readonly tasks: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly costs: Array<Record<string, unknown>> = [];
  readonly runs = [
    {
      run_id: "run_1",
      spec_id: "spec_1",
      project_id: "project_1",
      pr_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/1",
      status: "running"
    }
  ];
  readonly projects = [{ project_id: "project_1", config: { githubCredentialRef: "credential/github/dev" } }];

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("FROM runs r") && sql.includes("JOIN projects p") && sql.includes("r.pr_url")) {
      const run = this.runs.find((candidate) => candidate.run_id === params[0]);
      const project = this.projects.find((candidate) => candidate.project_id === run?.project_id);
      return {
        rows:
          run === undefined || project === undefined
            ? []
            : [
                {
                  run_id: run.run_id,
                  spec_id: run.spec_id,
                  project_id: run.project_id,
                  pr_url: run.pr_url,
                  config: project.config
                }
              ],
        rowCount: run === undefined || project === undefined ? 0 : 1
      };
    }
    if (sql.includes("FROM tasks") && sql.includes("kind = 'ci'") && sql.includes("LIMIT 1")) {
      const task = this.tasks.find((candidate) => candidate.run_id === params[0] && candidate.kind === "ci");
      return { rows: task === undefined ? [] : [task], rowCount: task === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      this.tasks.push({
        task_id: params[0],
        run_id: params[1],
        kind: "ci",
        title: "Poll pull request CI",
        status: "running",
        agent_kind: "system",
        cli: "github",
        model: null,
        attempt: 1
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'running', started_at")) {
      const task = this.findTask(params[0]);
      task.status = "running";
      task.attempt = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'done'")) {
      Object.assign(this.findTask(params[0]), { status: "done", outcome: "ok" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'failed'")) {
      Object.assign(this.findTask(params[0]), { status: "failed", outcome: "failed", failure_kind: "ci_failed" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'running', outcome = 'pending'")) {
      Object.assign(this.findTask(params[0]), { status: "running", outcome: "pending", failure_kind: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith(`INSERT INTO ${eventsTableName}`)) {
      this.events.push({
        run_id: params[0],
        task_id: params[1],
        spec_id: params[2],
        project_id: params[3],
        event_type: params[4],
        payload: JSON.parse(String(params[5]))
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql === "SELECT * FROM runs WHERE run_id = $1") {
      const run = this.runs.find((candidate) => candidate.run_id === params[0]);
      return { rows: run === undefined ? [] : [run], rowCount: run === undefined ? 0 : 1 };
    }
    if (sql.includes("SELECT * FROM tasks")) {
      return { rows: this.tasks.filter((task) => task.run_id === params[0]), rowCount: this.tasks.length };
    }
    if (sql.startsWith("SELECT * FROM events")) {
      return { rows: this.events.filter((event) => event.run_id === params[0]), rowCount: this.events.length };
    }
    if (sql.startsWith("SELECT * FROM cost_records")) {
      return { rows: this.costs, rowCount: 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  asPgPool() {
    return this as never;
  }

  private findTask(taskId: unknown): Record<string, unknown> {
    const task = this.tasks.find((candidate) => candidate.task_id === taskId);
    if (task === undefined) {
      throw new Error(`missing task: ${String(taskId)}`);
    }
    return task;
  }
}
