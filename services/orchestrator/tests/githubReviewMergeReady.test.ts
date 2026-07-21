// Covers GitHubReviewMergeService.markReadyForReview. The bug this guards
// against: a REST `PATCH /pulls/{n} { draft: false }` does NOT un-draft a PR
// (GitHub silently ignores it), so a draft PR would stay draft and `native_queue`
// would be refused. The flip MUST go through the GraphQL
// `markPullRequestReadyForReview` mutation (which needs the PR's node id).

import { describe, expect, it } from "vitest";
import type { GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GitHubReviewMergeService } from "../src/engine/providers/githubReviewMerge.js";

function recordingHttp(responses: (req: GitHubHttpRequest) => GitHubHttpResponse) {
  const requests: GitHubHttpRequest[] = [];
  return {
    requests,
    client: {
      request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
        requests.push(req);
        return responses(req);
      },
    },
  };
}

describe("markReadyForReview un-drafts via the GraphQL mutation", () => {
  it("reads the PR node id then issues markPullRequestReadyForReview (no REST PATCH)", async () => {
    const http = recordingHttp((req) =>
      req.method === "GET"
        ? { status: 200, body: { node_id: "PR_node_123" } }
        : { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } },
    );
    const service = new GitHubReviewMergeService(http.client);

    await service.markReadyForReview({ repo: { owner: "cat-cave", name: "fix" }, pullNumber: 7, token: "t" });

    // No request un-drafts via REST PATCH; the flip goes through GraphQL.
    expect(http.requests.some((r) => r.method === "PATCH")).toBe(false);
    const graphql = http.requests.find((r) => r.path === "/graphql");
    expect(graphql?.method).toBe("POST");
    expect(JSON.stringify(graphql?.body)).toContain("markPullRequestReadyForReview");
    expect(JSON.stringify(graphql?.body)).toContain("PR_node_123");
  });

  it("tolerates the idempotent 'not a draft pull request' GraphQL error", async () => {
    const http = recordingHttp((req) =>
      req.method === "GET"
        ? { status: 200, body: { node_id: "PR_node_123" } }
        : { status: 200, body: { errors: [{ message: "Pull request is not a draft pull request" }] } },
    );
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.markReadyForReview({ repo: { owner: "o", name: "r" }, pullNumber: 1, token: "t" }),
    ).resolves.toBeUndefined();
  });

  it("throws on a non-idempotent GraphQL error", async () => {
    const http = recordingHttp((req) =>
      req.method === "GET"
        ? { status: 200, body: { node_id: "PR_node_123" } }
        : { status: 200, body: { errors: [{ message: "Resource not accessible by integration" }] } },
    );
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.markReadyForReview({ repo: { owner: "o", name: "r" }, pullNumber: 1, token: "t" }),
    ).rejects.toThrow(/GraphQL error/u);
  });

  it("throws when the PR lookup returns no node_id", async () => {
    const http = recordingHttp(() => ({ status: 200, body: {} }));
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.markReadyForReview({ repo: { owner: "o", name: "r" }, pullNumber: 1, token: "t" }),
    ).rejects.toThrow(/node_id/u);
  });
});
