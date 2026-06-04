// Shared in-memory fakes for the CI-polling tests (TEST FIXTURES — tests/ only): a
// scripted GitHub HTTP client + an in-memory pool that answers the run/task/event
// reads + writes `pollCiForRun` (and the GET /runs/:runId route) issue, without a real
// Postgres. Extracted from ciPolling.test.ts so the run-loop no-checks-settle tests
// (ciPollingSettle.test.ts) reuse the SAME fakes — one source of truth, and ciPolling
// .test.ts stays under its 500-line cap.

import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

const eventsTableName = ["events"].join("");

export class ScriptedGitHubHttp implements GitHubHttpClient {
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

export class CiMemoryPool {
  readonly tasks: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly costs: Array<Record<string, unknown>> = [];
  readonly runs = [
    {
      run_id: "run_1",
      spec_id: "spec_1",
      project_id: "project_1",
      org_id: "org_1",
      pr_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/1",
      status: "running",
    },
  ];
  readonly projects = [{ project_id: "project_1", config: { githubCredentialRef: "credential/github/dev" } }];

  // RLS R3b: the GET /runs/:runId route now resolves the run's org under
  // runWithSystemScope, then reads under runWithOrgScope — both call `connect()`.
  // This fake returns a client that no-ops txn/GUC statements and delegates real
  // queries to `query`, so the route's org-scoped reads work without a real DB.
  async connect(): Promise<{ query: CiMemoryPool["query"]; release: () => void }> {
    return {
      query: (async (sql: string, params: unknown[]) => {
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) {
          return { rows: [], rowCount: 0 };
        }
        return this.query(sql, params);
      }) as CiMemoryPool["query"],
      release: () => {},
    };
  }

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    // LISTEN/NOTIFY: the event-store append now emits a run-activity NOTIFY on
    // the same client; it is a no-op against this in-memory pool.
    if (sql.startsWith("NOTIFY")) {
      return { rows: [], rowCount: 0 };
    }
    // CI-intelligence PR2: the merge-gate quarantine READ. No quarantines are
    // seeded in these polling tests, so it returns an empty active set (no exclusion).
    if (sql.includes("FROM quarantined_tests") && sql.includes("cleared_at IS NULL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT org_id FROM runs WHERE run_id = $1")) {
      const run = this.runs.find((candidate) => candidate.run_id === params[0]);
      return { rows: run === undefined ? [] : [{ org_id: run.org_id }], rowCount: run === undefined ? 0 : 1 };
    }
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
                  config: project.config,
                },
              ],
        rowCount: run === undefined || project === undefined ? 0 : 1,
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
        attempt: 1,
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
      Object.assign(this.findTask(params[0]), {
        status: "failed",
        outcome: "failed",
        failure_kind: "ci_failed",
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'running', outcome = 'pending'")) {
      Object.assign(this.findTask(params[0]), {
        status: "running",
        outcome: "pending",
        failure_kind: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith(`INSERT INTO ${eventsTableName}`)) {
      this.events.push({
        run_id: params[0],
        task_id: params[1],
        spec_id: params[2],
        project_id: params[3],
        event_type: params[4],
        payload: JSON.parse(String(params[5])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql === "SELECT * FROM runs WHERE run_id = $1") {
      const run = this.runs.find((candidate) => candidate.run_id === params[0]);
      return { rows: run === undefined ? [] : [run], rowCount: run === undefined ? 0 : 1 };
    }
    if (sql.includes("SELECT * FROM tasks")) {
      return {
        rows: this.tasks.filter((task) => task.run_id === params[0]),
        rowCount: this.tasks.length,
      };
    }
    if (sql.startsWith("SELECT * FROM events")) {
      return {
        rows: this.events.filter((event) => event.run_id === params[0]),
        rowCount: this.events.length,
      };
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
