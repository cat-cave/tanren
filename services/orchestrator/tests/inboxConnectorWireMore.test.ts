// Inbox source-connector wire-shape + normalization tests — Linear + Jira
// (mutation ratchet). Split out of inboxConnectorWire.test.ts to stay under the
// 500-line file cap; same approach as the sibling GitHub/Sentry file: drive each
// REAL connector through a recording STUB transport and assert the request it
// built (endpoint / method / auth / query / pagination) + the normalized
// IngestedItem output (id/title/body-line composition, severity, skip rules,
// error paths). No spies, no mock-only assertions.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  createJiraConnector,
  createLinearConnector,
  type InboxSource,
  type JiraHttpClient,
  type JiraHttpRequest,
  type LinearHttpClient,
  type LinearHttpRequest,
} from "../src/engine/forge/inbox/index.js";

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/linear/x", value: "lin_api_token" });
await secrets.put({ ref: "credential/jira/x", value: "jira_api_token" });

const linearSource: InboxSource = {
  id: "src_linear",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "linear · cat-cave",
  detail: "open",
  config: { provider: "linear", tokenRef: "credential/linear/x", teamId: "team_1" },
  enabled: true,
  autoRoute: false,
};

const jiraSource: InboxSource = {
  id: "src_jira",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "jira · cat-cave",
  detail: "open",
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

function recordLinear(body: unknown, status = 200): { client: LinearHttpClient; calls: LinearHttpRequest[] } {
  const calls: LinearHttpRequest[] = [];
  return {
    calls,
    client: {
      async request(input) {
        calls.push(input);
        return { status, body };
      },
    },
  };
}

function recordJira(body: unknown, status = 200): { client: JiraHttpClient; calls: JiraHttpRequest[] } {
  const calls: JiraHttpRequest[] = [];
  return {
    calls,
    client: {
      async request(input) {
        calls.push(input);
        return { status, body };
      },
    },
  };
}

describe("linear connector — request wire shape", () => {
  it("POSTs the GraphQL endpoint with the raw token, first:50, and the open-state filter scoped to team + project", async () => {
    const { client, calls } = recordLinear({ data: { issues: { nodes: [] } } });
    await createLinearConnector({ secrets, linearHttp: client }).fetch({
      ...linearSource,
      config: { ...linearSource.config, projectId: "proj_9" },
    });
    const req = calls[0]!;
    expect(req.endpoint).toBe("https://api.linear.app/graphql");
    expect(req.token).toBe("lin_api_token");
    expect(req.variables["first"]).toBe(50);
    expect(req.variables["filter"]).toEqual({
      state: { type: { nin: ["completed", "canceled"] } },
      team: { id: { eq: "team_1" } },
      project: { id: { eq: "proj_9" } },
    });
    expect(req.query).toContain("issues(filter: $filter, first: $first, orderBy: updatedAt)");
  });

  it("omits the team/project filter keys when neither is configured", async () => {
    const { client, calls } = recordLinear({ data: { issues: { nodes: [] } } });
    await createLinearConnector({ secrets, linearHttp: client }).fetch({
      ...linearSource,
      config: { provider: "linear", tokenRef: "credential/linear/x" },
    });
    expect(calls[0]!.variables["filter"]).toEqual({ state: { type: { nin: ["completed", "canceled"] } } });
  });

  it("throws when the configured tokenRef is absent from the secret store", async () => {
    const { client } = recordLinear({ data: { issues: { nodes: [] } } });
    await expect(
      createLinearConnector({ secrets, linearHttp: client }).fetch({
        ...linearSource,
        config: { ...linearSource.config, tokenRef: "credential/linear/missing" },
      }),
    ).rejects.toThrow(/no secret at ref/);
  });
});

describe("linear connector — normalization", () => {
  it("maps id/title, joins description + url into the body, and prefixes externalId with linear-", async () => {
    const { client } = recordLinear({
      data: {
        issues: {
          nodes: [
            {
              id: "lin_1",
              title: "checkout crash",
              description: "repro steps",
              url: "https://linear.app/x",
              priority: 3,
            },
          ],
        },
      },
    });
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);
    expect(items[0]!.externalId).toBe("linear-lin_1");
    expect(items[0]!.body).toBe("repro steps\n\nhttps://linear.app/x");
    expect(items[0]!.severity).toBe("info"); // priority 3 (medium), no label
  });

  it("includes only the present body lines (description-only, url-only, and a missing-priority issue defaults to info)", async () => {
    const { client } = recordLinear({
      data: {
        issues: {
          nodes: [
            { id: "a", title: "desc only", description: "just a description" },
            { id: "b", title: "url only", url: "https://linear.app/b" },
            { id: "c", title: "neither" },
          ],
        },
      },
    });
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);
    expect(items[0]!.body).toBe("just a description"); // url line omitted
    expect(items[1]!.body).toBe("https://linear.app/b"); // description line omitted
    expect(items[2]!.body).toBe(""); // both omitted
    // priority absent → defaults to 0 (no priority) → info severity.
    expect(items[2]!.severity).toBe("info");
  });

  it("escalates a bug/regression/critical label to fail regardless of priority and maps priority 1->fail, 2->warn", async () => {
    const { client } = recordLinear({
      data: {
        issues: {
          nodes: [
            { id: "a", title: "labelled bug, low prio", priority: 4, labels: { nodes: [{ name: "Bug" }] } },
            { id: "b", title: "urgent", priority: 1, labels: { nodes: [] } },
            { id: "c", title: "high", priority: 2, labels: { nodes: [] } },
            { id: "d", title: "perf labelled", priority: 4, labels: { nodes: [{ name: "perf" }] } },
            { id: "e", title: "warn labelled", priority: 4, labels: { nodes: [{ name: "needs-warning" }] } },
            { id: "f", title: "regression labelled", priority: 4, labels: { nodes: [{ name: "regression" }] } },
          ],
        },
      },
    });
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);
    expect(items[0]!.severity).toBe("fail"); // bug label wins over low priority
    expect(items[1]!.severity).toBe("fail"); // urgent
    expect(items[2]!.severity).toBe("warn"); // high
    expect(items[3]!.severity).toBe("warn"); // perf label
    expect(items[4]!.severity).toBe("warn"); // "warn" substring label arm
    expect(items[5]!.severity).toBe("fail"); // regression label
  });

  it("keeps only label-matching issues when a label filter is configured (case-insensitive)", async () => {
    const { client } = recordLinear({
      data: {
        issues: {
          nodes: [
            { id: "a", title: "kept", priority: 0, labels: { nodes: [{ name: "Bug" }] } },
            { id: "b", title: "dropped", priority: 0, labels: { nodes: [{ name: "chore" }] } },
          ],
        },
      },
    });
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch({
      ...linearSource,
      config: { ...linearSource.config, labels: ["bug"] },
    });
    expect(items.map((i) => i.externalId)).toEqual(["linear-a"]);
  });

  it("skips nodes missing an id or title and returns no items on a non-200 / non-array body", async () => {
    const { client } = recordLinear({
      data: { issues: { nodes: [{ title: "no id" }, { id: "x" }, { id: "y", title: "kept" }] } },
    });
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);
    expect(items.map((i) => i.externalId)).toEqual(["linear-y"]);

    const notOk = recordLinear({ data: { issues: { nodes: [{ id: "z", title: "x" }] } } }, 500);
    expect(await createLinearConnector({ secrets, linearHttp: notOk.client }).fetch(linearSource)).toHaveLength(0);
    const noData = recordLinear({ data: {} });
    expect(await createLinearConnector({ secrets, linearHttp: noData.client }).fetch(linearSource)).toHaveLength(0);
  });
});

describe("jira connector — request wire shape", () => {
  it("POSTs the v3 search endpoint with basic auth, maxResults 50 and the summary/description/priority fields", async () => {
    const { client, calls } = recordJira({ issues: [] });
    await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    const req = calls[0]!;
    expect(req.url).toBe("https://cat-cave.atlassian.net/rest/api/3/search");
    expect(req.authorization).toBe(`Basic ${Buffer.from("bot@cat-cave.dev:jira_api_token").toString("base64")}`);
    expect(req.body["maxResults"]).toBe(50);
    expect(req.body["fields"]).toEqual(["summary", "description", "priority"]);
    expect(req.body["jql"]).toBe('project = "CAT" ORDER BY updated DESC');
  });

  it("strips trailing slashes from the base url for both the search url and the browse links", async () => {
    const { client, calls } = recordJira({ issues: [{ key: "CAT-1", fields: { summary: "s" } }] });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch({
      ...jiraSource,
      config: { ...jiraSource.config, baseUrl: "https://cat-cave.atlassian.net///" },
    });
    expect(calls[0]!.url).toBe("https://cat-cave.atlassian.net/rest/api/3/search");
    expect(items[0]!.body).toContain("https://cat-cave.atlassian.net/browse/CAT-1");
  });

  it("composes jql from project + status and lets an explicit jql win", async () => {
    const proj = recordJira({ issues: [] });
    await createJiraConnector({ secrets, jiraHttp: proj.client }).fetch({
      ...jiraSource,
      config: { ...jiraSource.config, status: "To Do" },
    });
    expect(proj.calls[0]!.body["jql"]).toBe('project = "CAT" AND status = "To Do" ORDER BY updated DESC');

    const explicit = recordJira({ issues: [] });
    await createJiraConnector({ secrets, jiraHttp: explicit.client }).fetch({
      ...jiraSource,
      config: { ...jiraSource.config, jql: "assignee = currentUser()" },
    });
    expect(explicit.calls[0]!.body["jql"]).toBe("assignee = currentUser()");

    const bare = recordJira({ issues: [] });
    await createJiraConnector({ secrets, jiraHttp: bare.client }).fetch({
      ...jiraSource,
      config: { provider: "jira", baseUrl: "https://x.atlassian.net", email: "e@x", tokenRef: "credential/jira/x" },
    });
    expect(bare.calls[0]!.body["jql"]).toBe("ORDER BY updated DESC");
  });
});

describe("jira connector — normalization", () => {
  it("flattens ADF descriptions, passes plain strings through, and appends the browse url", async () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    };
    const { client } = recordJira({
      issues: [
        { key: "CAT-1", fields: { summary: "adf one", description: adf, priority: { name: "Low" } } },
        { key: "CAT-2", fields: { summary: "plain one", description: "just text", priority: { name: "Low" } } },
        { key: "CAT-3", fields: { summary: "no desc", description: null, priority: { name: "Low" } } },
      ],
    });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items[0]!.body).toBe("first second\n\nhttps://cat-cave.atlassian.net/browse/CAT-1");
    expect(items[1]!.body).toBe("just text\n\nhttps://cat-cave.atlassian.net/browse/CAT-2");
    // a null/empty description leaves only the deep link (no leading blank line join).
    expect(items[2]!.body).toBe("https://cat-cave.atlassian.net/browse/CAT-3");
    expect(items[0]!.externalId).toBe("jira-CAT-1");
  });

  it("walks nested ADF content arrays, skips null/non-text nodes, and joins text leaves with a space", async () => {
    const adf = {
      type: "doc",
      content: [
        // a null entry in a content array must be skipped, not crash the walk.
        null,
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "text", text: "alpha" }] },
            { type: "listItem", content: [{ type: "text", text: "beta" }] },
          ],
        },
        // a node with no text + no content contributes nothing.
        { type: "rule" },
      ],
    };
    const { client } = recordJira({
      issues: [{ key: "CAT-7", fields: { summary: "nested", description: adf, priority: { name: "Low" } } }],
    });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items[0]!.body).toBe("alpha beta\n\nhttps://cat-cave.atlassian.net/browse/CAT-7");
  });

  it("treats an empty-text ADF (no text leaves) as no description, leaving only the browse url", async () => {
    const adf = { type: "doc", content: [{ type: "rule" }] };
    const { client } = recordJira({
      issues: [{ key: "CAT-8", fields: { summary: "empty adf", description: adf } }],
    });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items[0]!.body).toBe("https://cat-cave.atlassian.net/browse/CAT-8");
  });

  it("maps priority to severity (highest/critical/blocker/high->fail, medium->warn, else->info)", async () => {
    const { client } = recordJira({
      issues: [
        { key: "A", fields: { summary: "a", priority: { name: "Highest" } } },
        { key: "B", fields: { summary: "b", priority: { name: "High" } } },
        { key: "C", fields: { summary: "c", priority: { name: "Blocker" } } },
        { key: "D", fields: { summary: "d", priority: { name: "Medium" } } },
        { key: "E", fields: { summary: "e", priority: { name: "Low" } } },
        { key: "F", fields: { summary: "f" } }, // no priority → info
      ],
    });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items.map((i) => i.severity)).toEqual(["fail", "fail", "fail", "warn", "info", "info"]);
  });

  it("skips issues missing a key or a summary and returns no items on non-200 / non-array body", async () => {
    const { client } = recordJira({
      issues: [
        { fields: { summary: "no key" } },
        { key: "CAT-9", fields: {} }, // no summary
        { key: "CAT-10", fields: { summary: "kept" } },
      ],
    });
    const items = await createJiraConnector({ secrets, jiraHttp: client }).fetch(jiraSource);
    expect(items.map((i) => i.externalId)).toEqual(["jira-CAT-10"]);

    const notOk = recordJira({ issues: [{ key: "X", fields: { summary: "x" } }] }, 403);
    expect(await createJiraConnector({ secrets, jiraHttp: notOk.client }).fetch(jiraSource)).toHaveLength(0);
    const notArray = recordJira({ issues: "nope" });
    expect(await createJiraConnector({ secrets, jiraHttp: notArray.client }).fetch(jiraSource)).toHaveLength(0);
  });

  it("throws when the configured tokenRef is absent from the secret store", async () => {
    const { client } = recordJira({ issues: [] });
    await expect(
      createJiraConnector({ secrets, jiraHttp: client }).fetch({
        ...jiraSource,
        config: { ...jiraSource.config, tokenRef: "credential/jira/missing" },
      }),
    ).rejects.toThrow(/no secret at ref/);
  });
});
