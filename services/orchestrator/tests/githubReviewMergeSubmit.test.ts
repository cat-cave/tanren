// Covers GitHubReviewMergeService.submitReview — the real GitHub write the
// simulated reviewer drives. submitReview must POST to /pulls/:n/reviews with the
// event (COMMENT for the self-PR-safe simulated path, or APPROVE/REQUEST_CHANGES for
// a distinct reviewer identity) + the reasoning body. (The PR-diff read moved onto
// the sha-addressed `CodeHost.readDiff` in the VcsProvider→CodeHost decomposition.)
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

describe("submitReview posts a real GitHub review", () => {
  it("POSTs the APPROVE event + body to /pulls/:n/reviews", async () => {
    const http = recordingHttp(() => ({ status: 200, body: { id: 1 } }));
    const service = new GitHubReviewMergeService(http.client);

    await service.submitReview({
      repo: { owner: "cat-cave", name: "fix" },
      pullNumber: 7,
      event: "APPROVE",
      body: "criteria satisfied",
      token: "t",
    });

    const req = http.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/repos/cat-cave/fix/pulls/7/reviews");
    expect(req?.body).toEqual({ event: "APPROVE", body: "criteria satisfied" });
  });

  it("POSTs REQUEST_CHANGES with the reasoning body", async () => {
    const http = recordingHttp(() => ({ status: 201, body: { id: 2 } }));
    const service = new GitHubReviewMergeService(http.client);

    await service.submitReview({
      repo: { owner: "o", name: "r" },
      pullNumber: 3,
      event: "REQUEST_CHANGES",
      body: "criterion 2 is unmet",
      token: "t",
    });

    expect(http.requests[0]?.body).toEqual({ event: "REQUEST_CHANGES", body: "criterion 2 is unmet" });
  });

  it("POSTs a COMMENT event (self-PR-safe) with the verdict-bearing body", async () => {
    const http = recordingHttp(() => ({ status: 200, body: { id: 3 } }));
    const service = new GitHubReviewMergeService(http.client);

    await service.submitReview({
      repo: { owner: "cat-cave", name: "fix" },
      pullNumber: 9,
      event: "COMMENT",
      body: "Tanren simulated review — VERDICT: approve\n\ncriteria satisfied",
      token: "t",
    });

    const req = http.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/repos/cat-cave/fix/pulls/9/reviews");
    expect(req?.body).toEqual({
      event: "COMMENT",
      body: "Tanren simulated review — VERDICT: approve\n\ncriteria satisfied",
    });
  });

  it("throws on a non-2xx submit response", async () => {
    const http = recordingHttp(() => ({ status: 422, body: { message: "Unprocessable" } }));
    const service = new GitHubReviewMergeService(http.client);
    await expect(
      service.submitReview({ repo: { owner: "o", name: "r" }, pullNumber: 1, event: "APPROVE", body: "x", token: "t" }),
    ).rejects.toThrow(/submit-review failed/u);
  });
});
