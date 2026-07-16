import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubChecksChannel } from "../src/engine/notifications/channels/githubChecks.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { SecretStore, SecretValue } from "../src/engine/contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../src/engine/config/orgConfig.js";
import type { NotificationPayload, NotificationTargetRow } from "../src/engine/notifications/index.js";

// GitHub Checks channel tests. The GitHub HTTP client is mocked so we
// assert the request shape (PR head-sha lookup, then commit-status POST) and
// the token resolution path (App installation token vs static) without
// a real network.

function target(overrides: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "github_checks",
    destination: overrides.destination ?? "https://github.com/cat-cave/tanren/pull/42",
    label: "github checks",
    enabled: true,
    baseUrl: null,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const payload: NotificationPayload = {
  title: "[FAIL] run.failed",
  body: "run failed",
  severity: "fail",
  eventName: "run.failed",
  url: "https://tanren.example/runs/run_1",
};

const TEST_ORG_ID = "org";
const STATIC_REF = `credential/github/org/${TEST_ORG_ID}/default`;
const APP_REF = `credential/github_app/org/${TEST_ORG_ID}/cat-cave`;

class MemorySecrets implements SecretStore {
  constructor(private readonly map: Record<string, string>) {}
  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.map[ref];
    return value === undefined ? undefined : { value };
  }
}

class FakeGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];
  constructor(private readonly responder: (req: GitHubHttpRequest) => GitHubHttpResponse) {}
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    return this.responder(input);
  }
}

function prAndStatusResponder(headSha: string): (req: GitHubHttpRequest) => GitHubHttpResponse {
  return (req) => {
    if (req.method === "GET" && req.path.includes("/pulls/")) {
      return { status: 200, body: { head: { sha: headSha } } };
    }
    if (req.method === "POST" && req.path.includes("/statuses/")) {
      return { status: 201, body: { id: 1 } };
    }
    return { status: 404, body: undefined };
  };
}

describe("GithubChecksChannel", () => {
  it("posts a commit status to the PR head sha via the static token path", async () => {
    const http = new FakeGitHubHttp(prAndStatusResponder("deadbeef"));
    const secrets = new MemorySecrets({ [STATIC_REF]: "static-token-123" });
    const channel = new GithubChecksChannel({ secrets, http, staticRef: STATIC_REF, orgId: TEST_ORG_ID });

    await channel.publish(target(), payload);

    expect(http.requests).toHaveLength(2);
    const lookup = http.requests[0]!;
    expect(lookup.method).toBe("GET");
    expect(lookup.path).toBe("/repos/cat-cave/tanren/pulls/42");
    expect(lookup.token).toBe("static-token-123");

    const post = http.requests[1]!;
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/repos/cat-cave/tanren/statuses/deadbeef");
    expect(post.token).toBe("static-token-123");
    const body = post.body as Record<string, unknown>;
    // fail -> error
    expect(body.state).toBe("error");
    expect(body.context).toBe("tanren");
    expect(body.target_url).toBe("https://tanren.example/runs/run_1");
  });

  it("maps severity to commit-status state", async () => {
    const cases: Array<[NotificationPayload["severity"], string]> = [
      ["ok", "success"],
      ["info", "success"],
      ["warn", "failure"],
      ["fail", "error"],
    ];
    for (const [severity, expected] of cases) {
      const http = new FakeGitHubHttp(prAndStatusResponder("sha1"));
      const channel = new GithubChecksChannel({
        secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
        http,
        staticRef: STATIC_REF,
        orgId: TEST_ORG_ID,
      });
      await channel.publish(target(), { ...payload, severity });
      const post = http.requests.find((r) => r.method === "POST")!;
      expect((post.body as Record<string, unknown>).state).toBe(expected);
    }
  });

  it("mints an auto-rotating App installation token via the P3-0003 resolver", async () => {
    // A real RSA key so the minter's JWT signing succeeds; the mint HTTP call
    // is stubbed to return an installation token.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const secrets = new MemorySecrets({
      [APP_REF]: JSON.stringify({ appId: "123456", privateKeyPem: pem }),
    });
    let mintCalls = 0;
    const mintFetch: typeof fetch = async () => {
      mintCalls += 1;
      return new Response(JSON.stringify({ token: "ghs_installation_token", expires_at: "2999-01-01T00:00:00Z" }), {
        status: 201,
      });
    };
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl: mintFetch });
    const installation: OrgGithubAppInstallation = {
      installationId: "987",
      appId: "123456",
      credentialRef: APP_REF,
      installedAt: "2026-01-01T00:00:00Z",
    };
    const http = new FakeGitHubHttp(prAndStatusResponder("appsha"));
    const channel = new GithubChecksChannel({ secrets, installation, minter, http, orgId: TEST_ORG_ID });

    await channel.publish(target(), payload);

    expect(mintCalls).toBe(1);
    const post = http.requests.find((r) => r.method === "POST")!;
    expect(post.token).toBe("ghs_installation_token");
    expect(post.refreshToken).toBeTypeOf("function");
  });

  it("throws when the status POST does not return 201", async () => {
    const http = new FakeGitHubHttp((req) => {
      if (req.method === "GET") return { status: 200, body: { head: { sha: "s" } } };
      return { status: 403, body: { message: "forbidden" } };
    });
    const channel = new GithubChecksChannel({
      secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
      http,
      staticRef: STATIC_REF,
      orgId: TEST_ORG_ID,
    });
    await expect(channel.publish(target(), payload)).rejects.toThrow(/github_checks publish failed: HTTP 403/u);
  });

  it("sets the status description to the (truncated) payload title and context to tanren", async () => {
    const http = new FakeGitHubHttp(prAndStatusResponder("sha"));
    const channel = new GithubChecksChannel({
      secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
      http,
      staticRef: STATIC_REF,
      orgId: TEST_ORG_ID,
    });
    await channel.publish(target(), { ...payload, title: "x".repeat(200) });
    const post = http.requests.find((r) => r.method === "POST")!;
    const body = post.body as Record<string, unknown>;
    expect(body.context).toBe("tanren");
    expect((body.description as string).length).toBe(140);
    expect((body.description as string).endsWith("...")).toBe(true);
  });

  it("omits target_url when payload.url is unset", async () => {
    const http = new FakeGitHubHttp(prAndStatusResponder("sha"));
    const channel = new GithubChecksChannel({
      secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
      http,
      staticRef: STATIC_REF,
      orgId: TEST_ORG_ID,
    });
    const { url: _url, ...noUrl } = payload;
    await channel.publish(target(), noUrl);
    const post = http.requests.find((r) => r.method === "POST")!;
    expect(post.body as Record<string, unknown>).not.toHaveProperty("target_url");
  });

  it("uses the GET pull endpoint then the POST statuses endpoint on the resolved head sha", async () => {
    const http = new FakeGitHubHttp(prAndStatusResponder("deadbeef"));
    const channel = new GithubChecksChannel({
      secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
      http,
      staticRef: STATIC_REF,
      orgId: TEST_ORG_ID,
    });
    await channel.publish(target({ destination: "https://github.com/org/repo/pull/7" }), payload);
    expect(http.requests[0]!.path).toBe("/repos/org/repo/pulls/7");
    expect(http.requests[1]!.path).toBe("/repos/org/repo/statuses/deadbeef");
  });

  it("throws when the PR lookup does not return 200", async () => {
    const http = new FakeGitHubHttp(() => ({ status: 404, body: { message: "not found" } }));
    const channel = new GithubChecksChannel({
      secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
      http,
      staticRef: STATIC_REF,
      orgId: TEST_ORG_ID,
    });
    await expect(channel.publish(target(), payload)).rejects.toThrow(/github_checks PR fetch failed: HTTP 404/u);
  });

  it("throws when the PR response carries no head sha", async () => {
    const cases: Array<unknown> = [
      // empty sha rejected
      { head: { sha: "" } },
      // missing sha
      { head: {} },
      // null head
      { head: null },
      // missing head
      {},
      // array body
      [1, 2, 3],
      // primitive body
      "not-an-object",
    ];
    for (const prBody of cases) {
      const http = new FakeGitHubHttp((req) => {
        if (req.method === "GET") return { status: 200, body: prBody };
        return { status: 201, body: {} };
      });
      const channel = new GithubChecksChannel({
        secrets: new MemorySecrets({ [STATIC_REF]: "tok" }),
        http,
        staticRef: STATIC_REF,
        orgId: TEST_ORG_ID,
      });
      await expect(channel.publish(target(), payload)).rejects.toThrow(/github_checks PR response missing head sha/u);
      // The status POST must NOT fire when the head sha is unresolved.
      expect(http.requests.some((r) => r.method === "POST")).toBe(false);
    }
  });
});
