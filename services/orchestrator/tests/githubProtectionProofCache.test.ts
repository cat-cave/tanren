import { describe, expect, it } from "vitest";
import {
  GitHubStatusService,
  type GitHubHttpClient,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "../src/engine/providers/github.js";
import { GitHubProtectionProofCache } from "../src/engine/providers/githubProtectionProofCache.js";

class RecordingHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected GitHub request");
    return response;
  }
}

function required(context: string): GitHubHttpResponse {
  return { status: 200, body: { contexts: [context] } };
}

const baseInput = {
  repo: { owner: "o", name: "r" },
  token: "token-1",
  baseBranch: "main",
  authorizationIdentity: "org:tenant:credential-a",
  endpointIdentity: "https://api.github.com",
};

describe("GitHub protection proof cache", () => {
  it("serves a successful proof from cache within the freshness window", async () => {
    const http = new RecordingHttp([required("build")]);
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["build"]);
    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["build"]);
    expect(http.requests).toHaveLength(1);
  });

  it("separates repository, base branch, authorization identity, and endpoint keys", async () => {
    const inputs = [
      baseInput,
      { ...baseInput, repo: { owner: "other", name: "r" } },
      { ...baseInput, baseBranch: "release" },
      { ...baseInput, authorizationIdentity: "org:tenant:credential-b" },
      { ...baseInput, endpointIdentity: "https://ghe.example/api/v3" },
    ];
    const http = new RecordingHttp(inputs.map((_, index) => required(`check-${index}`)));
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    for (const [index, input] of inputs.entries()) {
      await expect(service.fetchRequiredContexts(input)).resolves.toEqual([`check-${index}`]);
    }
    expect(http.requests).toHaveLength(inputs.length);
  });

  it("refreshes after the injected TTL expires", async () => {
    let now = 1_000;
    const cache = new GitHubProtectionProofCache({ ttlMs: 100, now: () => now });
    const http = new RecordingHttp([required("before-expiry"), required("after-expiry")]);
    const service = new GitHubStatusService(http, { protectionProofCache: cache });

    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["before-expiry"]);
    now = 1_099;
    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["before-expiry"]);
    now = 1_100;
    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["after-expiry"]);
    expect(http.requests).toHaveLength(2);
  });

  it("does not reuse proof across a token refresh even with the same stable identity", async () => {
    const http = new RecordingHttp([required("old-token"), required("fresh-token")]);
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["old-token"]);
    await expect(service.fetchRequiredContexts({ ...baseInput, token: "token-2" })).resolves.toEqual(["fresh-token"]);
    expect(http.requests).toHaveLength(2);
  });

  it("does not reuse proof across an endpoint change", async () => {
    const http = new RecordingHttp([required("github-cloud"), required("github-enterprise")]);
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["github-cloud"]);
    await expect(
      service.fetchRequiredContexts({ ...baseInput, endpointIdentity: "https://ghe.example/api/v3" }),
    ).resolves.toEqual(["github-enterprise"]);
    expect(http.requests).toHaveLength(2);
  });

  it("does not cache a failed proof", async () => {
    const http = new RecordingHttp([{ status: 403, body: { message: "denied" } }, required("recovered")]);
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    await expect(service.fetchRequiredContexts(baseInput)).rejects.toThrow(/HTTP 403/u);
    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["recovered"]);
    expect(http.requests).toHaveLength(2);
  });

  it("does not cache an ambiguous rules proof", async () => {
    const http = new RecordingHttp([
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { name: "main", protected: true } },
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: [] },
      required("recovered"),
    ]);
    const service = new GitHubStatusService(http, { protectionProofCache: new GitHubProtectionProofCache() });

    await expect(service.fetchRequiredContexts(baseInput)).rejects.toThrow(/no full protection or ruleset proof/u);
    await expect(service.fetchRequiredContexts(baseInput)).resolves.toEqual(["recovered"]);
    expect(http.requests).toHaveLength(5);
  });
});
