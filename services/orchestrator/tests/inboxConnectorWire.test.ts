// Inbox source-connector wire-shape + normalization tests (mutation ratchet).
//
// These tests pin the observable behavior of the authority-backed inbox source
// connectors (GitHub Issues and Sentry) that sibling tests leave un-asserted:
// the exact request shape each connector sends through its injected transport (method /
// path / auth / query / pagination) and the issue->IngestedItem normalization
// (id/title/body/severity, slice caps, dedupe-via-skip, error/not-found paths).
//
// Every test drives a REAL connector through a recording STUB transport and
// asserts the request it built + the normalized output it returned — no spies,
// no mock-only assertions.

import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest } from "../src/engine/providers/github.js";
import {
  createGitHubIssuesConnector,
  createSentryConnector,
  IntakeSourceAuthError,
  IntakeSourceFetchError,
  UnsupportedInboxProviderError,
  type InboxSource,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryIntakeAuthority,
} from "../src/engine/forge/inbox/index.js";
import { testSentryIntakeAuthority } from "./helpers/sentryIntakeAuthority.js";

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/x", value: "ghs_static_token" });
await secrets.put({ ref: "credential/sentry/x/g/1", value: "sntrys_token" });

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
  config: { org: "cat-cave", project: "app" },
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

const sentryAuthority = testSentryIntakeAuthority("credential/sentry/x/g/1");
const missingSentryAuthority = testSentryIntakeAuthority("credential/sentry/missing/g/1");

const sentryConnector = (sentryHttp: SentryHttpClient, authority: SentryIntakeAuthority = sentryAuthority) =>
  createSentryConnector({ secrets, sentryHttp, authority });

describe("github issues connector — request wire shape", () => {
  it("rejects removed bare-secret-ref providers before provider I/O", async () => {
    const { client, calls } = recordGitHub([]);
    const secretRead = vi.spyOn(secrets, "get");
    try {
      await expect(
        createGitHubIssuesConnector({ secrets, githubHttp: client }).fetch({
          ...githubSource,
          config: {
            provider: "linear",
            owner: "cat-cave",
            repo: "app",
            tokenRef: "credential/linear/x",
          },
        }),
      ).rejects.toThrow(UnsupportedInboxProviderError);
      expect(secretRead).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally {
      secretRead.mockRestore();
    }
  });

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

  it("THROWS loudly on a failed fetch (no-silent-fallbacks): non-200, auth, and non-array 200 are not 'no issues'", async () => {
    // A 404/5xx-class non-200 is a LOUD transient fetch error, never an empty list.
    const notOk = recordGitHub([{ number: 1, title: "x", labels: [] }], 404);
    await expect(
      createGitHubIssuesConnector({ secrets, githubHttp: notOk.client }).fetch(githubSource),
    ).rejects.toThrow(IntakeSourceFetchError);
    // A 401 is a LOUD auth error (a misconfiguration), never "no issues".
    const denied = recordGitHub({ message: "Bad credentials" }, 401);
    await expect(
      createGitHubIssuesConnector({ secrets, githubHttp: denied.client }).fetch(githubSource),
    ).rejects.toThrow(IntakeSourceAuthError);
    // A 200 whose body is not an issues array is a failed read (shape changed /
    // error envelope) — LOUD, not silently zero issues.
    const notArray = recordGitHub({ message: "boom" }, 200);
    await expect(
      createGitHubIssuesConnector({ secrets, githubHttp: notArray.client }).fetch(githubSource),
    ).rejects.toThrow(IntakeSourceFetchError);
  });

  it("returns a genuine empty list on a 200-with-an-empty-array (the legitimate 'no open issues')", async () => {
    const empty = recordGitHub([], 200);
    expect(await createGitHubIssuesConnector({ secrets, githubHttp: empty.client }).fetch(githubSource)).toHaveLength(
      0,
    );
  });
});

describe("sentry connector — request wire shape", () => {
  it("GETs the org/project issues endpoint with the unresolved query + 14d statsPeriod, the base url and the secret token", async () => {
    const { client, calls } = recordSentry([]);
    await sentryConnector(client).fetch(sentrySource);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.baseUrl).toBe("https://sentry.io");
    expect(req.token).toBe("sntrys_token");
    expect(req.path).toBe("/api/0/projects/cat-cave/app/issues/?query=is%3Aunresolved&statsPeriod=14d");
  });

  it("honours a custom query and appends the optional level clause", async () => {
    const { client, calls } = recordSentry([]);
    await sentryConnector(client).fetch({
      ...sentrySource,
      config: { ...sentrySource.config, query: "is:unresolved is:assigned", level: "fatal" },
    });
    // the query is URL-encoded (`:` → %3A, space → +) and the level clause is
    // appended before the fixed 14d statsPeriod.
    expect(calls[0]!.path).toBe(
      `/api/0/projects/cat-cave/app/issues/?query=is%3Aunresolved+is${"%3A"}assigned+level%3Afatal&statsPeriod=14d`,
    );
  });

  it("throws when the authorized generation secret is absent from the secret store", async () => {
    const { client } = recordSentry([]);
    await expect(sentryConnector(client, missingSentryAuthority).fetch(sentrySource)).rejects.toThrow(
      /missing integration secret for generation/u,
    );
  });

  it("rejects cloned authority before secret or Sentry HTTP I/O", async () => {
    const { client, calls } = recordSentry([]);
    const authentic = await sentryAuthority({ orgId: "org_a", projectId: "project_a", resourceId: "app" });
    const cloned = { ...authentic, metadata: { ...authentic.metadata } } as typeof authentic;
    const secretRead = vi.spyOn(secrets, "get");
    try {
      await expect(sentryConnector(client, async () => cloned).fetch(sentrySource)).rejects.toThrow(
        /org grant does not match/u,
      );
      expect(secretRead).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } finally {
      secretRead.mockRestore();
    }
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
    const items = await sentryConnector(client).fetch(sentrySource);
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
    const items = await sentryConnector(client).fetch(sentrySource);
    // none of permalink/culprit/type-value/level/events/users lines fire.
    expect(items[0]!.body).toBe("");
  });

  it("includes only the present body lines for a partial issue (permalink + events, no culprit/level/users)", async () => {
    const { client } = recordSentry([{ id: "9", title: "partial", permalink: "https://sentry.io/9/", count: 5 }]);
    const items = await sentryConnector(client).fetch(sentrySource);
    expect(items[0]!.body).toBe("https://sentry.io/9/\nevents: 5");
  });

  it("emits a type:value line when only the metadata type is present (value defaults to empty, trailing space trimmed)", async () => {
    const { client } = recordSentry([{ id: "9", title: "t", metadata: { type: "ValueError" } }]);
    const items = await sentryConnector(client).fetch(sentrySource);
    // value absent → `ValueError: ` then .trim() → "ValueError:".
    expect(items[0]!.body).toBe("ValueError:");
  });

  it("emits a type:value line when only the metadata value is present (type defaults to 'error')", async () => {
    const { client } = recordSentry([{ id: "9", title: "t", metadata: { value: "boom" } }]);
    const items = await sentryConnector(client).fetch(sentrySource);
    expect(items[0]!.body).toBe("error: boom");
  });

  it("emits the users-affected line for a string userCount but not when it is absent", async () => {
    const present = recordSentry([{ id: "9", title: "t", userCount: "12" }]);
    expect((await sentryConnector(present.client).fetch(sentrySource))[0]!.body).toBe("users affected: 12");
    const absent = recordSentry([{ id: "9", title: "t" }]);
    expect((await sentryConnector(absent.client).fetch(sentrySource))[0]!.body).toBe("");
  });

  it("falls back title to culprit then metadata value then shortId and maps fatal/warning levels", async () => {
    const { client } = recordSentry([
      { id: "1", culprit: "from culprit", level: "fatal" },
      { id: "2", metadata: { value: "from metadata" }, level: "warning" },
      { id: "3", shortId: "APP-3", level: "debug" },
    ]);
    const items = await sentryConnector(client).fetch(sentrySource);
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
    const items = await sentryConnector(client).fetch(sentrySource);
    expect(items.map((i) => i.externalId)).toEqual(["sentry-6"]);
  });

  it("THROWS loudly on a failed fetch (no-silent-fallbacks): a 401 is an auth error, a non-array 200 is a failed read", async () => {
    // A 401 is a LOUD auth error (the token was rejected), never silently "no issues".
    const denied = recordSentry([{ id: "1", title: "x" }], 401);
    await expect(sentryConnector(denied.client).fetch(sentrySource)).rejects.toThrow(IntakeSourceAuthError);
    // A 200 whose body is not an issues array is a failed read — LOUD.
    const notArray = recordSentry({ detail: "nope" });
    await expect(sentryConnector(notArray.client).fetch(sentrySource)).rejects.toThrow(IntakeSourceFetchError);
  });

  it("returns a genuine empty list on a 200-with-an-empty-array (no unresolved issues)", async () => {
    const empty = recordSentry([], 200);
    expect(await sentryConnector(empty.client).fetch(sentrySource)).toHaveLength(0);
  });
});
