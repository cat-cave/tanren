import { describe, expect, it } from "vitest";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { reconcileMaterializedFile } from "../src/routes/onboarding/materializeTemplate.js";

const INPUT = {
  repoUrl: "https://github.com/cat-cave/replay-proof",
  defaultBranch: "main",
  path: "package.json",
  content: '{"name":"replay-proof"}\n',
  message: "tanren compose: package.json",
};

class MaterializeHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly existingContent: string) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    if (input.method === "GET") {
      return {
        status: 200,
        body: {
          sha: "existing_blob_sha",
          encoding: "base64",
          content: Buffer.from(this.existingContent, "utf8").toString("base64"),
        },
      };
    }
    if (input.method === "PUT") {
      return { status: 200, body: { commit: { sha: "new_commit_sha" } } };
    }
    throw new Error(`unexpected ${input.method} ${input.path}`);
  }
}

describe("live template materialization reconciliation", () => {
  it("turns response-loss replay into an exact-content no-op with no second commit", async () => {
    const http = new MaterializeHttp(INPUT.content);
    const receipt = await reconcileMaterializedFile(http, { token: "test-token" }, INPUT);

    expect(receipt).toEqual({ commitSha: "existing_blob_sha" });
    expect(http.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("updates changed content using the observed blob CAS", async () => {
    const http = new MaterializeHttp("old bytes\n");
    const receipt = await reconcileMaterializedFile(http, { token: "test-token" }, INPUT);

    expect(receipt).toEqual({ commitSha: "new_commit_sha" });
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(http.requests[1]?.body).toMatchObject({ sha: "existing_blob_sha" });
  });
});
