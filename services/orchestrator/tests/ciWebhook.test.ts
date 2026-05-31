// P3-0028: a GitHub check_run/check_suite webhook resolves the affected run and
// advances its CI state by an authoritative re-fetch (poll fallback remains).

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import {
  advanceCiFromWebhook,
  CiWebhookUnsupportedEventError,
  pullRequestUrlsFromPayload,
} from "../src/engine/workflow/ciWebhook.js";

const PR_URL = "https://github.com/cat-cave/tanren-fixture-easy/pull/1";

describe("CI webhook (P3-0028)", () => {
  it("extracts PR URLs from a check_run payload", () => {
    expect(
      pullRequestUrlsFromPayload({
        check_run: { pull_requests: [{ html_url: PR_URL }, { html_url: PR_URL }] },
      }),
    ).toEqual([PR_URL]);
    expect(pullRequestUrlsFromPayload({ check_suite: { pull_requests: [{ html_url: PR_URL }] } })).toEqual([PR_URL]);
    expect(pullRequestUrlsFromPayload({ status: "success" })).toEqual([]);
  });

  it("rejects events that are not CI events", async () => {
    await expect(
      advanceCiFromWebhook({
        pool: new WebhookPool().asPgPool(),
        secrets: new FakeSecretStore(),
        githubHttp: new ScriptedGitHubHttp([]),
        event: "push",
        payload: {},
      }),
    ).rejects.toBeInstanceOf(CiWebhookUnsupportedEventError);
  });

  it("advances the matched run's CI state to passed", async () => {
    const pool = new WebhookPool();
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });

    const result = await advanceCiFromWebhook({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      githubHttp: new ScriptedGitHubHttp([
        { status: 200, body: { head: { sha: "abc123" }, base: { ref: "main" } } },
        {
          status: 200,
          body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
        },
        { status: 200, body: { statuses: [] } },
        { status: 404, body: { message: "Branch not protected" } },
      ]),
      event: "check_run",
      payload: { check_run: { pull_requests: [{ html_url: PR_URL }] } },
    });

    expect(result.matchedRunIds).toEqual(["run_1"]);
    expect(result.results[0]).toMatchObject({ runId: "run_1", status: "passed" });
    expect(events.events.map((e) => e.eventType)).toContain("ci.passed");
  });

  it("is a no-op when the webhook references an untracked PR", async () => {
    const result = await advanceCiFromWebhook({
      pool: new WebhookPool().asPgPool(),
      secrets: new FakeSecretStore(),
      githubHttp: new ScriptedGitHubHttp([]),
      event: "check_suite",
      payload: { check_suite: { pull_requests: [{ html_url: "https://github.com/x/y/pull/99" }] } },
    });
    expect(result).toMatchObject({ matchedRunIds: [], results: [] });
  });
});

class ScriptedGitHubHttp implements GitHubHttpClient {
  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

class WebhookPool {
  private readonly tasks: Array<Record<string, unknown>> = [];

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("SELECT run_id FROM runs WHERE pr_url = ANY")) {
      const urls = params[0] as string[];
      return urls.includes(PR_URL) ? { rows: [{ run_id: "run_1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM runs r") && sql.includes("JOIN projects p") && sql.includes("r.pr_url")) {
      return {
        rows: [
          {
            run_id: "run_1",
            spec_id: "spec_1",
            project_id: "project_1",
            pr_url: PR_URL,
            config: { githubCredentialRef: "credential/github/dev" },
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM tasks") && sql.includes("kind = 'ci'") && sql.includes("LIMIT 1")) {
      const task = this.tasks.find((t) => t.run_id === params[0]);
      return { rows: task === undefined ? [] : [task], rowCount: task === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      this.tasks.push({ task_id: params[0], run_id: params[1], kind: "ci", attempt: 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks")) {
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT\s+INTO\s+events/u.test(sql)) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  asPgPool() {
    return this as never;
  }
}
