// gv-2 forge-side retry convergence: production GitHubReviewMergeService +
// publishSimulatedReviewConvergent composition. Proves list-before-POST reclaim,
// no duplicate POST on stage retry, response-loss recovery, opposite-state
// conflict, wrong marker/login/head ignored, COMMENT rejected, pagination/
// malformed list failures, and exact call counts.
import { describe, expect, it } from "vitest";

import type { GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GitHubReviewMergeService, LIST_REVIEWS_PER_PAGE } from "../src/engine/providers/githubReviewMerge.js";
import {
  bodyContainsTanrenSimulatedMarker,
  publishSimulatedReviewConvergent,
  reconcileExistingSimulatedReviews,
  SimulatedReviewPublicationError,
  tanrenSimulatedReviewMarker,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REVIEWER = "tanren-reviewer";
const BODY_APPROVE = reviewBodyFor({ verdict: "approve", reasoning: "criteria ok" });
const BODY_CHANGES = reviewBodyFor({ verdict: "request_changes", reasoning: "fix nits" });

function reviewRow(opts: {
  id: number | string;
  state: string;
  commitId?: string;
  login?: string;
  body?: string;
  htmlUrl?: string | null;
}) {
  return {
    id: opts.id,
    state: opts.state,
    commit_id: opts.commitId ?? HEAD,
    user: { login: opts.login ?? REVIEWER },
    body: opts.body ?? BODY_APPROVE,
    ...(opts.htmlUrl === null
      ? {}
      : { html_url: opts.htmlUrl ?? `https://github.com/o/r/pull/1#pullrequestreview-${opts.id}` }),
  };
}

function recordingHttp(handler: (req: GitHubHttpRequest, n: number) => GitHubHttpResponse) {
  const requests: GitHubHttpRequest[] = [];
  return {
    requests,
    client: {
      request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
        requests.push(req);
        return handler(req, requests.length);
      },
    },
  };
}

function isList(req: GitHubHttpRequest): boolean {
  return req.method === "GET" && req.path.includes("/reviews");
}

function isPost(req: GitHubHttpRequest): boolean {
  return req.method === "POST" && req.path.endsWith("/reviews");
}

async function publishViaService(
  service: GitHubReviewMergeService,
  opts: {
    event?: "APPROVE" | "REQUEST_CHANGES";
    body?: string;
    headSha?: string;
    reviewerLogin?: string;
  } = {},
) {
  const event = opts.event ?? "APPROVE";
  const expectedState = event === "APPROVE" ? "approved" : "changes_requested";
  const headSha = opts.headSha ?? HEAD;
  const body = opts.body ?? (event === "APPROVE" ? BODY_APPROVE : BODY_CHANGES);
  return publishSimulatedReviewConvergent({
    expectedState,
    expectedHeadSha: headSha,
    expectedReviewerLogin: opts.reviewerLogin ?? REVIEWER,
    listReviews: () =>
      service.listPullRequestReviews({
        repo: { owner: "o", name: "r" },
        pullNumber: 1,
        token: "t",
      }),
    postReview: async () => {
      const receipt = await service.submitReview({
        repo: { owner: "o", name: "r" },
        pullNumber: 1,
        event,
        body,
        commitId: headSha,
        token: "t",
      });
      if (receipt === undefined) throw new Error("no receipt");
      return receipt;
    },
  });
}

describe("tanren simulated review marker", () => {
  it("embeds exact durable marker lines in reviewBodyFor", () => {
    expect(bodyContainsTanrenSimulatedMarker(BODY_APPROVE, "approved")).toBe(true);
    expect(bodyContainsTanrenSimulatedMarker(BODY_APPROVE, "changes_requested")).toBe(false);
    expect(bodyContainsTanrenSimulatedMarker(BODY_CHANGES, "changes_requested")).toBe(true);
    // Mid-line spoof is not a match.
    expect(bodyContainsTanrenSimulatedMarker(`x ${tanrenSimulatedReviewMarker("approved")} y`, "approved")).toBe(false);
  });
});

describe("reconcileExistingSimulatedReviews (pure)", () => {
  it("ignores wrong head, wrong login, and wrong marker (no reclaim)", () => {
    const ignored = reconcileExistingSimulatedReviews({
      reviews: [
        {
          forgeReviewId: "1",
          state: "approved",
          forgeReviewUrl: "https://x/1",
          headSha: OTHER_HEAD,
          reviewerLogin: REVIEWER,
          body: BODY_APPROVE,
        },
        {
          forgeReviewId: "2",
          state: "approved",
          forgeReviewUrl: "https://x/2",
          headSha: HEAD,
          reviewerLogin: "human",
          body: BODY_APPROVE,
        },
        {
          forgeReviewId: "3",
          state: "approved",
          forgeReviewUrl: "https://x/3",
          headSha: HEAD,
          reviewerLogin: REVIEWER,
          body: "human approval without marker",
        },
        {
          // COMMENT without marker is ignored (not loud — not Tanren-owned).
          forgeReviewId: "4",
          state: "commented",
          forgeReviewUrl: "https://x/4",
          headSha: HEAD,
          reviewerLogin: REVIEWER,
          body: "plain comment",
        },
      ],
      expectedState: "approved",
      expectedHeadSha: HEAD,
      expectedReviewerLogin: REVIEWER,
    });
    expect(ignored).toEqual({ kind: "absent" });
  });

  it("rejects COMMENT with Tanren marker loud", () => {
    expect(() =>
      reconcileExistingSimulatedReviews({
        reviews: [
          {
            forgeReviewId: "4",
            state: "commented",
            forgeReviewUrl: "https://x/4",
            headSha: HEAD,
            reviewerLogin: REVIEWER,
            body: BODY_APPROVE,
          },
        ],
        expectedState: "approved",
        expectedHeadSha: HEAD,
        expectedReviewerLogin: REVIEWER,
      }),
    ).toThrow(/non-authoritative state 'commented'/u);
  });

  it("fails loud on opposite terminal Tanren state on same head", () => {
    expect(() =>
      reconcileExistingSimulatedReviews({
        reviews: [
          {
            forgeReviewId: "9",
            state: "changes_requested",
            forgeReviewUrl: "https://x/9",
            headSha: HEAD,
            reviewerLogin: REVIEWER,
            body: BODY_CHANGES,
          },
        ],
        expectedState: "approved",
        expectedHeadSha: HEAD,
        expectedReviewerLogin: REVIEWER,
      }),
    ).toThrow(/convergence conflict/u);
  });

  it("reuses exact match", () => {
    const result = reconcileExistingSimulatedReviews({
      reviews: [
        {
          forgeReviewId: "42",
          state: "approved",
          forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-42",
          headSha: HEAD,
          reviewerLogin: REVIEWER,
          body: BODY_APPROVE,
        },
      ],
      expectedState: "approved",
      expectedHeadSha: HEAD,
      expectedReviewerLogin: REVIEWER,
    });
    expect(result).toEqual({
      kind: "reuse",
      receipt: {
        forgeReviewId: "42",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-42",
        headSha: HEAD,
        reviewerLogin: REVIEWER,
      },
    });
  });
});

describe("publishSimulatedReviewConvergent via GitHubReviewMergeService", () => {
  it("stage retry: existing exact-head match returns receipt with ZERO POSTs", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) {
        return {
          status: 200,
          body: [reviewRow({ id: 9001, state: "APPROVED" })],
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const service = new GitHubReviewMergeService(http.client);
    const receipt = await publishViaService(service);
    expect(receipt.forgeReviewId).toBe("9001");
    expect(http.requests.filter(isPost)).toHaveLength(0);
    expect(http.requests.filter(isList)).toHaveLength(1);
  });

  it("accepted-then-lost response: POST fails, re-list reclaims, no second POST", async () => {
    let posts = 0;
    const http = recordingHttp((req) => {
      if (isList(req)) {
        // After the failed POST, the review is visible.
        if (posts === 0) return { status: 200, body: [] };
        return { status: 200, body: [reviewRow({ id: 77, state: "APPROVED" })] };
      }
      if (isPost(req)) {
        posts += 1;
        return { status: 504, body: { message: "Gateway Timeout" } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const service = new GitHubReviewMergeService(http.client);
    const receipt = await publishViaService(service);
    expect(receipt.forgeReviewId).toBe("77");
    expect(posts).toBe(1);
    expect(http.requests.filter(isPost)).toHaveLength(1);
    expect(http.requests.filter(isList)).toHaveLength(2);
  });

  it("first publish POSTs once when absent", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) return { status: 200, body: [] };
      if (isPost(req)) {
        return {
          status: 201,
          body: reviewRow({ id: 11, state: "APPROVED" }),
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const service = new GitHubReviewMergeService(http.client);
    const receipt = await publishViaService(service);
    expect(receipt.forgeReviewId).toBe("11");
    expect(http.requests.filter(isPost)).toHaveLength(1);
    expect(http.requests.filter(isList)).toHaveLength(1);
    expect(http.requests.filter(isPost)[0]?.retryTransient).toBe(false);
  });

  it("opposite state conflict fails loud with no POST", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) {
        return {
          status: 200,
          body: [reviewRow({ id: 5, state: "CHANGES_REQUESTED", body: BODY_CHANGES })],
        };
      }
      throw new Error(`unexpected POST`);
    });
    const service = new GitHubReviewMergeService(http.client);
    await expect(publishViaService(service)).rejects.toBeInstanceOf(SimulatedReviewPublicationError);
    await expect(publishViaService(service)).rejects.toThrow(/convergence conflict/u);
    expect(http.requests.filter(isPost)).toHaveLength(0);
  });

  it("wrong marker / wrong login / wrong head do not reclaim; POST proceeds", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) {
        return {
          status: 200,
          body: [
            reviewRow({ id: 1, state: "APPROVED", body: "no marker" }),
            reviewRow({ id: 2, state: "APPROVED", login: "other-bot" }),
            reviewRow({ id: 3, state: "APPROVED", commitId: OTHER_HEAD }),
          ],
        };
      }
      if (isPost(req)) {
        return { status: 200, body: reviewRow({ id: 99, state: "APPROVED" }) };
      }
      throw new Error("unexpected");
    });
    const service = new GitHubReviewMergeService(http.client);
    const receipt = await publishViaService(service);
    expect(receipt.forgeReviewId).toBe("99");
    expect(http.requests.filter(isPost)).toHaveLength(1);
  });

  it("COMMENT with marker on list fails loud (never adopted, never POSTed)", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) {
        return {
          status: 200,
          body: [reviewRow({ id: 8, state: "COMMENTED", body: BODY_APPROVE })],
        };
      }
      throw new Error("unexpected POST");
    });
    const service = new GitHubReviewMergeService(http.client);
    await expect(publishViaService(service)).rejects.toThrow(/non-authoritative state 'commented'/u);
    expect(http.requests.filter(isPost)).toHaveLength(0);
  });

  it("malformed list body fails loud", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) return { status: 200, body: { not: "an array" } };
      throw new Error("unexpected");
    });
    const service = new GitHubReviewMergeService(http.client);
    await expect(publishViaService(service)).rejects.toThrow(/malformed|not an array/iu);
    expect(http.requests.filter(isPost)).toHaveLength(0);
  });

  it("pagination: exhausts pages; stuck/repeated page ids fail loud", async () => {
    const fullPage = Array.from({ length: LIST_REVIEWS_PER_PAGE }, (_, i) =>
      reviewRow({ id: i + 1, state: "COMMENTED", body: "noise", login: "human" }),
    );
    // Exhaustion path: page1 full, page2 partial → absent → POST.
    {
      const http = recordingHttp((req) => {
        if (isList(req)) {
          const page = Number(new URL(req.path, "https://api.github.com").searchParams.get("page") ?? "1");
          if (page === 1) return { status: 200, body: fullPage };
          return { status: 200, body: [reviewRow({ id: 999, state: "COMMENTED", body: "tail", login: "h" })] };
        }
        if (isPost(req)) return { status: 201, body: reviewRow({ id: 1000, state: "APPROVED" }) };
        throw new Error("unexpected");
      });
      const service = new GitHubReviewMergeService(http.client);
      const receipt = await publishViaService(service);
      expect(receipt.forgeReviewId).toBe("1000");
      expect(http.requests.filter(isList)).toHaveLength(2);
      expect(http.requests.filter(isPost)).toHaveLength(1);
    }
    // Stuck provider: page 2 repeats an id from page 1 → fail loud, no POST.
    {
      const http = recordingHttp((req) => {
        if (isList(req)) return { status: 200, body: fullPage };
        throw new Error("unexpected POST on stuck list");
      });
      const service = new GitHubReviewMergeService(http.client);
      await expect(publishViaService(service)).rejects.toThrow(/stuck\/repeated id/u);
      expect(http.requests.filter(isPost)).toHaveLength(0);
    }
  });

  it("head A never satisfies head B", async () => {
    const http = recordingHttp((req) => {
      if (isList(req)) {
        return {
          status: 200,
          body: [reviewRow({ id: 1, state: "APPROVED", commitId: HEAD })],
        };
      }
      if (isPost(req)) {
        return {
          status: 201,
          body: reviewRow({ id: 2, state: "APPROVED", commitId: OTHER_HEAD }),
        };
      }
      throw new Error("unexpected");
    });
    const service = new GitHubReviewMergeService(http.client);
    // Publishing for OTHER_HEAD must not reclaim HEAD's review.
    const receipt = await publishViaService(service, { headSha: OTHER_HEAD });
    expect(receipt.forgeReviewId).toBe("2");
    expect(receipt.headSha).toBe(OTHER_HEAD);
    expect(http.requests.filter(isPost)).toHaveLength(1);
  });
});
