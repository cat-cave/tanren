// Covers GitHubReviewMergeService.submitReview — the real GitHub write the
// simulated reviewer drives. submitReview must POST to /pulls/:n/reviews with the
// event (APPROVE/REQUEST_CHANGES for land-authoritative strict publication, or
// COMMENT for best-effort mirrors) + optional commit_id, and return a durable
// receipt for verdict-bearing events.
import { describe, expect, it } from "vitest";
import type { GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GitHubReviewMergeService } from "../src/engine/providers/githubReviewMerge.js";

const HEAD = "c".repeat(40);

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

function approveBody(id = 1) {
  return {
    id,
    state: "APPROVED",
    html_url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`,
    commit_id: HEAD,
    user: { login: "reviewer-bot" },
  };
}

describe("submitReview posts a real GitHub review", () => {
  it("POSTs the APPROVE event + body + commit_id and returns a durable receipt", async () => {
    const http = recordingHttp(() => ({ status: 200, body: approveBody(42) }));
    const service = new GitHubReviewMergeService(http.client);

    const receipt = await service.submitReview({
      repo: { owner: "cat-cave", name: "fix" },
      pullNumber: 7,
      event: "APPROVE",
      body: "criteria satisfied",
      commitId: HEAD,
      token: "t",
    });

    const req = http.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/repos/cat-cave/fix/pulls/7/reviews");
    expect(req?.body).toEqual({ event: "APPROVE", body: "criteria satisfied", commit_id: HEAD });
    expect(receipt).toEqual({
      forgeReviewId: "42",
      forgeReviewState: "approved",
      forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-42",
      headSha: HEAD,
      reviewerLogin: "reviewer-bot",
    });
  });

  it("POSTs REQUEST_CHANGES with the reasoning body and returns changes_requested receipt", async () => {
    const http = recordingHttp(() => ({
      status: 201,
      body: {
        id: 2,
        state: "CHANGES_REQUESTED",
        html_url: "https://github.com/o/r/pull/3#pullrequestreview-2",
        commit_id: HEAD,
        user: { login: "r" },
      },
    }));
    const service = new GitHubReviewMergeService(http.client);

    const receipt = await service.submitReview({
      repo: { owner: "o", name: "r" },
      pullNumber: 3,
      event: "REQUEST_CHANGES",
      body: "criterion 2 is unmet",
      commitId: HEAD,
      token: "t",
    });

    expect(http.requests[0]?.body).toEqual({
      event: "REQUEST_CHANGES",
      body: "criterion 2 is unmet",
      commit_id: HEAD,
    });
    expect(receipt?.forgeReviewState).toBe("changes_requested");
    expect(receipt?.forgeReviewId).toBe("2");
  });

  it("POSTs a COMMENT event (best-effort mirror) and returns no land receipt", async () => {
    const http = recordingHttp(() => ({
      status: 200,
      body: { id: 3, state: "COMMENTED", html_url: "https://x", commit_id: HEAD },
    }));
    const service = new GitHubReviewMergeService(http.client);

    const receipt = await service.submitReview({
      repo: { owner: "cat-cave", name: "fix" },
      pullNumber: 9,
      event: "COMMENT",
      body: "Tanren simulated review — VERDICT: approve\n\ncriteria satisfied",
      token: "t",
    });

    expect(http.requests[0]?.body).toEqual({
      event: "COMMENT",
      body: "Tanren simulated review — VERDICT: approve\n\ncriteria satisfied",
    });
    expect(receipt).toBeUndefined();
  });

  it("throws on a non-2xx submit response", async () => {
    const http = recordingHttp(() => ({ status: 422, body: { message: "Unprocessable" } }));
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.submitReview({
        repo: { owner: "o", name: "r" },
        pullNumber: 1,
        event: "APPROVE",
        body: "x",
        commitId: HEAD,
        token: "t",
      }),
    ).rejects.toThrow(/submit-review failed/u);
  });

  it("throws on a 2xx APPROVE response missing id/state/url/commit (malformed receipt)", async () => {
    const http = recordingHttp(() => ({ status: 200, body: { state: "COMMENTED" } }));
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.submitReview({
        repo: { owner: "o", name: "r" },
        pullNumber: 1,
        event: "APPROVE",
        body: "x",
        commitId: HEAD,
        token: "t",
      }),
    ).rejects.toThrow(/submit-review response/iu);
  });
});
