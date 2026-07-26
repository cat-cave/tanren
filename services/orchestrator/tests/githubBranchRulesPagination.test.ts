import { describe, expect, it } from "vitest";
import {
  GitHubStatusService,
  type GitHubHttpClient,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "../src/engine/providers/github.js";

class ScriptedHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected GitHub request");
    return response;
  }
}

const input = { repo: { owner: "o", name: "r" }, token: "t", baseBranch: "main" };

describe("GitHub branch-rule proof pagination", () => {
  it("rejects a required status check on a later full page rather than proving an empty requirement", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ type: "pull_request" }));
    const http = new ScriptedHttp([
      { status: 404, body: {} },
      { status: 200, body: { name: "main", protected: true } },
      { status: 200, body: { required_status_checks: null } },
      { status: 200, body: firstPage },
      { status: 200, body: [{ type: "required_status_checks" }] },
    ]);

    await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(/require status checks/u);
    expect(http.requests.map((request) => request.path)).toContain(
      "/repos/o/r/rules/branches/main?per_page=100&page=2",
    );
  });

  it("fails closed when a full rules page repeats instead of making pagination progress", async () => {
    const page = Array.from({ length: 100 }, () => ({ type: "pull_request" }));
    const http = new ScriptedHttp([
      { status: 404, body: {} },
      { status: 200, body: { name: "main", protected: true } },
      { status: 404, body: {} },
      { status: 200, body: page },
      { status: 200, body: page },
    ]);

    await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(
      /pagination made no progress/u,
    );
  });

  it.each(["workflows", "code_scanning", "required_deployments", "future_check_gate"])(
    "rejects unrepresentable %s rules instead of emitting empty required contexts",
    async (type) => {
      const http = new ScriptedHttp([
        { status: 404, body: {} },
        { status: 200, body: { name: "main", protected: true } },
        { status: 404, body: {} },
        { status: 200, body: [{ type }] },
      ]);

      await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(
        new RegExp(`unrepresentable or check-producing rule type ${type}`, "u"),
      );
    },
  );
});
