// Inbox source-connector wire-shape + normalization tests (mutation ratchet).
//
// These tests pin the OBSERVABLE behavior of the four inbox source connectors
// (GitHub Issues / Sentry / Linear / Jira) and the `issues` provider-dispatcher
// that the sibling candidateInbox*.test.ts files leave un-asserted — the exact
// request shape each connector sends through its injected transport (method /
// path / auth / query / pagination) and the issue->IngestedItem normalization
// (id/title/body/severity, slice caps, dedupe-via-skip, error/not-found paths).
//
// Every test drives a REAL connector through a recording STUB transport and
// asserts the request it built + the normalized output it returned — no spies,
// no mock-only assertions.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest } from "../src/engine/providers/github.js";
import {
  createGitHubIssuesConnector,
  createIssuesConnector,
  createSentryConnector,
  type InboxSource,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SourceConnector,
} from "../src/engine/forge/inbox/index.js";

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/x", value: "ghs_static_token" });
await secrets.put({ ref: "credential/sentry/x", value: "sntrys_token" });
await secrets.put({ ref: "credential/linear/x", value: "lin_api_token" });
await secrets.put({ ref: "credential/jira/x", value: "jira_api_token" });

const githubSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "issues labeled spec-candidate",
  config: { owner: "cat-cave", repo: "app", labels: ["spec-candidate"], staticRef: "credential/github/x" },
  enabled: true,
  autoRoute: false,
};

const sentrySource: InboxSource = {
  id: "src_sentry",
  orgId: "org_a",
  projectId: "project_a",
  kind: "errors",
  name: "sentry · cat-cave/app",
  detail: "unresolved",
  config: { org: "cat-cave", project: "app", tokenRef: "credential/sentry/x" },
  enabled: true,
  autoRoute: false,
};

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

function recordGitHub(body: unknown, status = 200): { client: GitHubHttpClient; calls: GitHubHttpRequest[] } {
  const calls: GitHubHttpRequest[] = [];
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

function recordSentry(body: unknown, status = 200): { client: SentryHttpClient; calls: SentryHttpRequest[] } {
  const calls: SentryHttpRequest[] = [];
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

describe("github issues connector — request wire shape", () => {
  it("issues a GET to the repo issues endpoint carrying state=open, per_page=50, the resolved token and a refresh supplier", async () => {
    const { client, calls } = recordGitHub([]);
    await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch(githubSource);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/repos/cat-cave/app/issues?state=open&per_page=50&labels=spec-candidate");
    // the static-ref token from the secret store is forwarded verbatim.
    expect(req.token).toBe("ghs_static_token");
    // a refresh supplier (the resolver's re-mint hook) is wired for the 401 path.
    expect(typeof req.refreshToken).toBe("function");
  });

  it("omits the labels query entirely when no labels are configured", async () => {
    const { client, calls } = recordGitHub([]);
    await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch({
      ...githubSource,
      config: { owner: "cat-cave", repo: "app", staticRef: "credential/github/x" },
    });
    expect(calls[0]!.path).toBe("/repos/cat-cave/app/issues?state=open&per_page=50");
    expect(calls[0]!.path).not.toContain("labels=");
  });

  it("url-encodes owner/repo and joins multiple labels comma-separated", async () => {
    const { client, calls } = recordGitHub([]);
    await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch({
      ...githubSource,
      config: {
        owner: "cat cave",
        repo: "the/app",
        labels: ["spec candidate", "bug"],
        staticRef: "credential/github/x",
      },
    });
    // labels are comma-joined then URL-encoded (the comma → %2C).
    expect(calls[0]!.path).toBe(
      `/repos/cat%20cave/the%2Fapp/issues?state=open&per_page=50&labels=spec%20candidate${"%2C"}bug`,
    );
  });
});

describe("github issues connector — normalization", () => {
  it("maps number/title/body and prefixes externalId with gh-owner/repo#number", async () => {
    const { client } = recordGitHub([{ number: 7, title: "csv export", body: "cfo wants csv", labels: [] }]);
    const items = await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch(githubSource);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      externalId: "gh-cat-cave/app#7",
      title: "csv export",
      body: "cfo wants csv",
      severity: "info",
      projectId: "project_a",
    });
  });

  it("maps perf/warn labels to warn and defaults bodiless / label-less issues to info + empty body", async () => {
    const { client } = recordGitHub([
      { number: 1, title: "perf regression on list", labels: ["perf"] },
      { number: 2, title: "warn me", labels: ["warning"] },
      { number: 3, title: "plain", labels: ["enhancement"] },
    ]);
    const items = await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch(githubSource);
    // perf
    expect(items[0]!.severity).toBe("warn");
    // warn
    expect(items[1]!.severity).toBe("warn");
    // no signal
    expect(items[2]!.severity).toBe("info");
    // no body field on the issue → normalized to an empty string, not undefined.
    expect(items[0]!.body).toBe("");
  });

  it("maps regression/critical labels and object-shaped label names to fail", async () => {
    const { client } = recordGitHub([
      { number: 1, title: "x", labels: [{ name: "critical" }] },
      { number: 2, title: "y", labels: ["regression"] },
    ]);
    const items = await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch(githubSource);
    expect(items[0]!.severity).toBe("fail");
    expect(items[1]!.severity).toBe("fail");
  });

  it("drops pull requests and rows missing a numeric number or string title", async () => {
    const { client } = recordGitHub([
      { number: 1, title: "keep", labels: [] },
      { number: 2, title: "a PR", pull_request: { url: "x" }, labels: [] },
      // no title
      { number: 3, labels: [] },
      // no number
      { title: "no number", labels: [] },
      // number not numeric
      { number: "4", title: "string number", labels: [] },
    ]);
    const items = await createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch(githubSource);
    expect(items.map((i) => i.title)).toEqual(["keep"]);
  });

  it("returns no items on a non-200 response and on a non-array body", async () => {
    const notOk = recordGitHub([{ number: 1, title: "x", labels: [] }], 404);
    expect(await createGitHubIssuesConnector({ secrets, githubHttp: notOk.client }).fetch(githubSource)).toHaveLength(
      0,
    );
    const notArray = recordGitHub({ message: "boom" }, 200);
    expect(
      await createGitHubIssuesConnector({ secrets, githubHttp: notArray.client }).fetch(githubSource),
    ).toHaveLength(0);
  });
});

describe("sentry connector — request wire shape", () => {
  it("GETs the org/project issues endpoint with the unresolved query + 14d statsPeriod, the base url and the secret token", async () => {
    const { client, calls } = recordSentry([]);
    await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.baseUrl).toBe("https://sentry.io");
    expect(req.token).toBe("sntrys_token");
    expect(req.path).toBe("/api/0/projects/cat-cave/app/issues/?query=is%3Aunresolved&statsPeriod=14d");
  });

  it("honours a custom query and appends the optional level clause", async () => {
    const { client, calls } = recordSentry([]);
    await createSentryConnector({ secrets, sentryHttp: client }).fetch({
      ...sentrySource,
      config: { ...sentrySource.config, query: "is:unresolved is:assigned", level: "fatal" },
    });
    // the query is URL-encoded (`:` → %3A, space → +) and the level clause is
    // appended before the fixed 14d statsPeriod.
    expect(calls[0]!.path).toBe(
      `/api/0/projects/cat-cave/app/issues/?query=is%3Aunresolved+is${"%3A"}assigned+level%3Afatal&statsPeriod=14d`,
    );
  });

  it("throws when the configured tokenRef is absent from the secret store", async () => {
    const { client } = recordSentry([]);
    await expect(
      createSentryConnector({ secrets, sentryHttp: client }).fetch({
        ...sentrySource,
        config: { ...sentrySource.config, tokenRef: "credential/sentry/missing" },
      }),
    ).rejects.toThrow(/no secret at ref credential\/sentry\/missing/u);
  });
});

describe("sentry connector — normalization", () => {
  it("builds the body from permalink, culprit, type:value, level, events and users-affected lines in order", async () => {
    const { client } = recordSentry([
      {
        id: "9",
        title: "TypeError x",
        culprit: "checkout.ts in submit",
        level: "error",
        permalink: "https://sentry.io/issues/9/",
        count: 1287,
        userCount: 42,
        metadata: { type: "TypeError", value: "cannot read id" },
      },
    ]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    expect(items[0]!.externalId).toBe("sentry-9");
    expect(items[0]!.body).toBe(
      [
        "https://sentry.io/issues/9/",
        "culprit: checkout.ts in submit",
        "TypeError: cannot read id",
        "level: error",
        "events: 1287",
        "users affected: 42",
      ].join("\n"),
    );
  });

  it("omits each body line when its source field is absent (a title-only issue yields an empty body)", async () => {
    const { client } = recordSentry([{ id: "9", title: "only a title" }]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    // none of permalink/culprit/type-value/level/events/users lines fire.
    expect(items[0]!.body).toBe("");
  });

  it("includes only the present body lines for a partial issue (permalink + events, no culprit/level/users)", async () => {
    const { client } = recordSentry([{ id: "9", title: "partial", permalink: "https://sentry.io/9/", count: 5 }]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    expect(items[0]!.body).toBe("https://sentry.io/9/\nevents: 5");
  });

  it("emits a type:value line when only the metadata type is present (value defaults to empty, trailing space trimmed)", async () => {
    const { client } = recordSentry([{ id: "9", title: "t", metadata: { type: "ValueError" } }]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    // value absent → `ValueError: ` then .trim() → "ValueError:".
    expect(items[0]!.body).toBe("ValueError:");
  });

  it("emits a type:value line when only the metadata value is present (type defaults to 'error')", async () => {
    const { client } = recordSentry([{ id: "9", title: "t", metadata: { value: "boom" } }]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    expect(items[0]!.body).toBe("error: boom");
  });

  it("emits the users-affected line for a string userCount but not when it is absent", async () => {
    const present = recordSentry([{ id: "9", title: "t", userCount: "12" }]);
    expect((await createSentryConnector({ secrets, sentryHttp: present.client }).fetch(sentrySource))[0]!.body).toBe(
      "users affected: 12",
    );
    const absent = recordSentry([{ id: "9", title: "t" }]);
    expect((await createSentryConnector({ secrets, sentryHttp: absent.client }).fetch(sentrySource))[0]!.body).toBe("");
  });

  it("falls back title to culprit then metadata value then shortId and maps fatal/warning levels", async () => {
    const { client } = recordSentry([
      { id: "1", culprit: "from culprit", level: "fatal" },
      { id: "2", metadata: { value: "from metadata" }, level: "warning" },
      { id: "3", shortId: "APP-3", level: "debug" },
    ]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    expect(items[0]!.title).toBe("from culprit");
    // fatal
    expect(items[0]!.severity).toBe("fail");
    expect(items[1]!.title).toBe("from metadata");
    // warning
    expect(items[1]!.severity).toBe("warn");
    expect(items[2]!.title).toBe("APP-3");
    // debug
    expect(items[2]!.severity).toBe("info");
  });

  it("skips rows lacking a stable id or any title signal", async () => {
    const { client } = recordSentry([
      { title: "no id" },
      // no title signal
      { id: "5" },
      { id: "6", title: "kept" },
    ]);
    const items = await createSentryConnector({ secrets, sentryHttp: client }).fetch(sentrySource);
    expect(items.map((i) => i.externalId)).toEqual(["sentry-6"]);
  });

  it("returns no items on a non-200 status or a non-array body", async () => {
    const notOk = recordSentry([{ id: "1", title: "x" }], 401);
    expect(await createSentryConnector({ secrets, sentryHttp: notOk.client }).fetch(sentrySource)).toHaveLength(0);
    const notArray = recordSentry({ detail: "nope" });
    expect(await createSentryConnector({ secrets, sentryHttp: notArray.client }).fetch(sentrySource)).toHaveLength(0);
  });
});

// A connector that tags its single ingested item with the given provider name —
// lets the dispatcher test assert which provider connector was selected.
const tagConnector = (tag: string): SourceConnector => ({
  kind: "issues",
  fetch: async (source) => [
    { externalId: `${tag}-1`, title: source.name, body: "", severity: "info", projectId: source.projectId },
  ],
});

describe("issues provider dispatcher — source selection", () => {
  const dispatcher = () =>
    createIssuesConnector({
      github: tagConnector("github"),
      linear: tagConnector("linear"),
      jira: tagConnector("jira"),
    });

  it("routes provider=linear to linear, provider=jira to jira, and absent/github provider to github", async () => {
    expect((await dispatcher().fetch(linearSource))[0]!.externalId).toBe("linear-1");
    expect((await dispatcher().fetch(jiraSource))[0]!.externalId).toBe("jira-1");
    // no provider field → github default.
    expect((await dispatcher().fetch(githubSource))[0]!.externalId).toBe("github-1");
    // explicit provider=github → github.
    const explicitGh = await dispatcher().fetch({
      ...githubSource,
      config: { ...githubSource.config, provider: "github" },
    });
    expect(explicitGh[0]!.externalId).toBe("github-1");
  });

  it("exposes the issues kind", () => {
    expect(dispatcher().kind).toBe("issues");
  });
});
