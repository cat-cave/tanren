// Jira inbox connector + `issues` provider-dispatcher tests.
//
// Exercises the Jira connector (MOCKED JiraHttpClient + secrets — no network /
// no live creds): the REST search → IngestedItem mapping (summary→title, ADF
// description + Jira URL → body), priority → severity, JQL vs project/status
// filter, idempotent re-ingest, and triage through the ingest pipeline. It also
// exercises the `issues` dispatcher routing `config.provider: jira` while
// leaving github + linear working under the same source kind. The pool is a
// lightweight in-memory stub keyed by SQL substring, mirroring the sibling
// candidateInboxLinear.test.ts.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import {
  createGitHubIssuesConnector,
  createIssuesConnector,
  createJiraConnector,
  createLinearConnector,
  ingestSource,
  type InboxEngineDeps,
  type InboxSource,
  type JiraHttpClient,
  type JiraHttpRequest,
  type LinearHttpClient,
  type SourceConnector,
} from "../src/engine/forge/inbox/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

// A Jira source wired under the `issues` kind (dispatch by config.provider).
const jiraSource: InboxSource = {
  id: "src_jira",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "jira · cat-cave",
  detail: "open issues",
  config: {
    provider: "jira",
    baseUrl: "https://cat-cave.atlassian.net",
    email: "bot@cat-cave.dev",
    tokenRef: "credential/jira/x",
    project: "CAT",
  },
  enabled: true,
  autoRoute: false,
};

const githubSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "issues labeled spec-candidate",
  config: {
    owner: "cat-cave",
    repo: "app",
    labels: ["spec-candidate"],
    staticRef: "credential/github/x",
  },
  enabled: true,
  autoRoute: false,
};

const linearSource: InboxSource = {
  id: "src_linear",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "linear · cat-cave",
  detail: "open issues",
  config: { provider: "linear", tokenRef: "credential/linear/x", teamId: "team_1" },
  enabled: true,
  autoRoute: false,
};

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/x", value: "ghs_token" });
await secrets.put({ ref: "credential/linear/x", value: "lin_api_token" });
await secrets.put({ ref: "credential/jira/x", value: "jira_api_token" });

// A fake JiraHttpClient returning a fixed search payload (no network/creds).
// The body mirrors Jira's `{ issues: [...] }` search envelope.
function fakeJira(issues: unknown[]): { client: JiraHttpClient; calls: JiraHttpRequest[] } {
  const calls: JiraHttpRequest[] = [];
  const client: JiraHttpClient = {
    async request(input) {
      calls.push(input);
      return { status: 200, body: { issues } };
    },
  };
  return { client, calls };
}

function fakeLinear(): LinearHttpClient {
  return {
    async request() {
      return { status: 200, body: { data: { issues: { nodes: [] } } } };
    },
  };
}

function fakeGitHub(issues: unknown[]): GitHubHttpClient {
  return {
    async request() {
      return { status: 200, body: issues };
    },
  };
}

// In-memory pool that tracks candidates so the ingest upsert is observable.
function stubPool(): { pool: pg.Pool; candidates: Map<string, Record<string, unknown>> } {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const sources = new Map<string, InboxSource>([[jiraSource.id, jiraSource]]);
  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    const src = sources.get(c.source_id as string)!;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, candidates };
}

function depsFor(connectors: ReadonlyMap<string, SourceConnector>, pool: pg.Pool): InboxEngineDeps {
  // The deterministic triage fixture stands in for the real provider answerer.
  return { pool, connectors, answerer: createDeterministicTriageAnswerer() };
}

// A description in Atlassian Document Format (the API v3 default shape).
const adfDescription = {
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "repro: clear cart then submit" }] }],
};

const jiraIssues = [
  {
    key: "CAT-12",
    fields: {
      summary: "checkout crashes on empty cart",
      description: adfDescription,
      priority: { name: "Highest" },
    },
  },
  {
    key: "CAT-13",
    fields: {
      summary: "CSV export for reports",
      // plain-string description (older configs)
      description: "cfo wants csv",
      priority: { name: "Medium" },
    },
  },
  {
    key: "CAT-14",
    fields: {
      summary: "tidy up settings copy",
      description: null,
      priority: { name: "Low" },
    },
  },
  // A degenerate issue with neither key nor summary — must be dropped.
  { fields: { priority: { name: "High" } } },
];

describe("jira connector (mocked)", () => {
  it("maps jira issues to candidates with description + url body", async () => {
    const { client, calls } = fakeJira(jiraIssues);
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);

    expect(items).toHaveLength(3);
    // externalId is the stable Jira issue key (idempotency key).
    expect(items[0]?.externalId).toBe("jira-CAT-12");
    expect(items[0]?.title).toBe("checkout crashes on empty cart");
    // body flattens the ADF description and carries the Jira deep link.
    expect(items[0]?.body).toContain("repro: clear cart then submit");
    expect(items[0]?.body).toContain("https://cat-cave.atlassian.net/browse/CAT-12");
    // a plain-string description passes through unchanged.
    expect(items[1]?.body).toContain("cfo wants csv");
    // the request hit the v3 search endpoint via Basic auth built from the
    // configured email + the token from secrets, scoped by JQL to the project.
    expect(calls[0]?.url).toBe("https://cat-cave.atlassian.net/rest/api/3/search");
    const expectedAuth = `Basic ${Buffer.from("bot@cat-cave.dev:jira_api_token").toString("base64")}`;
    expect(calls[0]?.authorization).toBe(expectedAuth);
    expect(calls[0]?.body["jql"]).toBe('project = "CAT" ORDER BY updated DESC');
  });

  it("maps jira priority to severity (highest/high→fail, medium→warn, else→info)", async () => {
    const { client } = fakeJira(jiraIssues);
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    // Highest
    expect(items[0]?.severity).toBe("fail");
    // Medium
    expect(items[1]?.severity).toBe("warn");
    // Low
    expect(items[2]?.severity).toBe("info");
  });

  it("uses an explicit jql when provided (overrides project/status)", async () => {
    const { client, calls } = fakeJira([]);
    await createJiraConnector({ secrets, jiraHttp: client }).fetch({
      ...jiraSource,
      config: { ...jiraSource.config, jql: "assignee = currentUser() AND statusCategory != Done" },
    });
    expect(calls[0]?.body["jql"]).toBe("assignee = currentUser() AND statusCategory != Done");
  });

  it("composes jql from a project + status filter", async () => {
    const { client, calls } = fakeJira([]);
    await createJiraConnector({ secrets, jiraHttp: client }).fetch({
      ...jiraSource,
      config: { ...jiraSource.config, status: "To Do" },
    });
    expect(calls[0]?.body["jql"]).toBe('project = "CAT" AND status = "To Do" ORDER BY updated DESC');
  });

  it("returns no items on a non-200 response", async () => {
    const client: JiraHttpClient = {
      async request() {
        return { status: 401, body: { errorMessages: ["bad creds"] } };
      },
    };
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items).toHaveLength(0);
  });

  it("throws when the configured token ref is missing from the secret store", async () => {
    const { client } = fakeJira([]);
    await expect(
      createJiraConnector({ secrets, jiraHttp: client }).fetch({
        ...jiraSource,
        config: { ...jiraSource.config, tokenRef: "credential/jira/missing" },
      }),
    ).rejects.toThrow(/no secret at ref/u);
  });

  it("ingests + triages jira candidates as triaged (fail → bug variant)", async () => {
    const { client } = fakeJira(jiraIssues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([
      ["issues", createJiraConnector({ secrets, jiraHttp: client })],
    ]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), jiraSource);
    expect(out).toHaveLength(3);
    expect(out[0]?.status).toBe("triaged");
    expect(out[0]?.triage?.verdict).toBe("needs_call");
    expect(out[0]?.triage?.discoveryVariant).toBe("bug");
    expect(candidates.size).toBe(3);
  });

  it("is idempotent: re-ingesting the same jira issue updates rather than duplicates", async () => {
    const issues = [{ key: "CAT-99", fields: { summary: "v1", description: null, priority: { name: "Low" } } }];
    const { client } = fakeJira(issues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([
      ["issues", createJiraConnector({ secrets, jiraHttp: client })],
    ]);
    const deps = depsFor(connectors, pool);
    await ingestSource(deps, jiraSource);
    issues[0]!.fields.summary = "v2";
    await ingestSource(deps, jiraSource);
    expect(candidates.size).toBe(1);
    expect([...candidates.values()][0]?.title).toBe("v2");
  });
});

describe("issues dispatcher (jira provider routing)", () => {
  const dispatcher = () =>
    createIssuesConnector({
      github: createGitHubIssuesConnector({
        secrets,
        githubHttp: fakeGitHub([{ number: 1, title: "gh issue", body: "", labels: [] }]),
      }),
      linear: createLinearConnector({ secrets, linearHttp: fakeLinear() }),
      jira: createJiraConnector({
        secrets,
        jiraHttp: fakeJira([
          {
            key: "CAT-1",
            fields: { summary: "jira issue", description: null, priority: { name: "Low" } },
          },
        ]).client,
      }),
    });

  it("routes config.provider=jira to the Jira connector", async () => {
    const items = await dispatcher().fetch(jiraSource);
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("jira-CAT-1");
  });

  it("leaves github working (no provider → github)", async () => {
    const items = await dispatcher().fetch(githubSource);
    expect(items[0]?.externalId).toBe("gh-cat-cave/app#1");
  });

  it("leaves linear working (provider=linear → linear, here empty)", async () => {
    const items = await dispatcher().fetch(linearSource);
    expect(items).toHaveLength(0);
  });
});
