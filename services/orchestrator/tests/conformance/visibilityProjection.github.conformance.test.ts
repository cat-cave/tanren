// Drives the FROZEN `VisibilityProjection` conformance harness
// (`visibilityProjectionConformance.ts`, tanren-owns-the-engine.md §0, §6) against
// the GitHub impl — through `harden(new GitHubVisibilityProjection(...))`, the ONLY
// surface the engine ever holds. It proves the best-effort severance for the real
// GitHub projection:
//   - a THROWING GitHub call becomes a `ProjectionOutcome.failed` and NEVER rejects
//     to the caller (the harness's throwing + decision-unchanged cases);
//   - an ABSENT method resolves to `skipped` (the harness's empty case);
//   - and the SUCCESS path returns `projected` with the human-facing PR handle.
//
// The fake GitHub transport is a TEST FIXTURE (it lives HERE, under tests/, never in
// src/), mirroring the scripted transport in `vcsProvider.conformance.test.ts`. A
// `makeThrowing()` projection wraps a transport whose every request THROWS, so the
// PR-open (and any) call rejects — and the hardened surface must still never reject.

import { describe, expect, it } from "vitest";
import type { ResolvedVcsToken } from "../../src/engine/contracts/codeHostTypes.js";
import { harden, type VisibilityProjection } from "../../src/engine/contracts/visibilityProjection.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import { GitHubVisibilityProjection } from "../../src/engine/providers/githubVisibilityProjection.js";
import { describeVisibilityProjectionConformance } from "./visibilityProjectionConformance.js";

const REPO_FULL_NAME = "cat-cave/apex";
const PR_NUMBER = 7;
const PR_URL = "https://github.com/cat-cave/apex/pull/7";
const PR_NODE_ID = "PR_kwDOabc123";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const ISSUE_NUMBER = 42;
const ISSUE_URL = "https://github.com/cat-cave/apex/issues/42";

const ok = (body: unknown): GitHubHttpResponse => ({ status: 200, body });

/** A resolved token fixture — the projection passes only its `.token`/`.refresh`. */
function fakeToken(): ResolvedVcsToken {
  return { token: "ghp_projection", source: "static", refresh: async () => "ghp_projection" };
}

/**
 * A scripted GitHub HTTP transport answering exactly the endpoints the projection
 * exercises: PR find (none) + create (201), commit-status post (201), review submit
 * (201), the base-retarget PATCH (200), the tracking-issue POST (201), and the
 * mark-ready flow (PR node-id GET 200 + GraphQL mutation 200). Routes on method +
 * path so the suite can call operations in any order. Only fields the impl reads.
 */
class SuccessGitHubHttp implements GitHubHttpClient {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const path = input.path.split("?")[0] ?? input.path;
    // openOrUpdateChangeRequest: list (no open PR) then create (201).
    if (input.method === "GET" && path.endsWith("/pulls")) return ok([]);
    if (input.method === "POST" && path.endsWith("/pulls")) {
      return { status: 201, body: { number: PR_NUMBER, html_url: PR_URL, draft: true } };
    }
    // publishGate: POST /statuses/{sha} → 201.
    if (input.method === "POST" && path.includes("/statuses/")) {
      return { status: 201, body: {} };
    }
    // publishReview: POST /pulls/{n}/reviews → 201.
    if (input.method === "POST" && path.endsWith("/reviews")) {
      return { status: 201, body: {} };
    }
    // retargetChangeRequest: PATCH /pulls/{n} { base } → 200 with the new base.
    if (input.method === "PATCH" && /\/pulls\/\d+$/u.test(path)) {
      const base = (input.body as { base?: unknown } | undefined)?.base;
      return ok({ number: PR_NUMBER, base: { ref: typeof base === "string" ? base : "main" } });
    }
    // openTrackingIssue: POST /issues → 201 with the issue number + html_url.
    if (input.method === "POST" && path.endsWith("/issues")) {
      return { status: 201, body: { number: ISSUE_NUMBER, html_url: ISSUE_URL } };
    }
    // markChangeRequestReady: GET /pulls/{n} (node id) then POST /graphql (mutation).
    if (input.method === "GET" && /\/pulls\/\d+$/u.test(path)) {
      return ok({ number: PR_NUMBER, node_id: PR_NODE_ID });
    }
    if (input.method === "POST" && path === "/graphql") {
      return ok({ data: { markPullRequestReadyForReview: { pullRequest: { id: PR_NODE_ID } } } });
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

/** A transport whose every request THROWS — drives the projection's `failed` path. */
class ThrowingGitHubHttp implements GitHubHttpClient {
  async request(_input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    throw new Error("GitHub transport unavailable (simulated)");
  }
}

/** A projection providing NO methods — drives the conformance `skipped` case. */
const EMPTY_PROJECTION: VisibilityProjection = {};

describeVisibilityProjectionConformance("GitHubVisibilityProjection", {
  // The throwing impl IS the real GitHubVisibilityProjection over a throwing transport:
  // its `openOrUpdateChangeRequest` rejects, and the hardened surface must sever it.
  makeThrowing: (): VisibilityProjection => new GitHubVisibilityProjection(new ThrowingGitHubHttp(), fakeToken),
  makeEmpty: (): VisibilityProjection => EMPTY_PROJECTION,
});

describe("GitHubVisibilityProjection success path (best-effort surface returns projected/ok)", () => {
  const makeSafe = () => harden(new GitHubVisibilityProjection(new SuccessGitHubHttp(), fakeToken));

  it("openOrUpdateChangeRequest returns a projected PR handle", async () => {
    const outcome = await makeSafe().openOrUpdateChangeRequest({
      repoFullName: REPO_FULL_NAME,
      headBranch: "feature",
      baseBranch: "main",
      title: "t",
    });
    expect(outcome).toEqual({ kind: "projected", value: { url: PR_URL, number: PR_NUMBER } });
  });

  it("publishGate posts the tanren/gate status and returns projected", async () => {
    const outcome = await makeSafe().publishGate({
      repoFullName: REPO_FULL_NAME,
      headSha: HEAD_SHA,
      verdict: "passed",
      summary: "Native pre-merge gate passed.",
    });
    expect(outcome.kind).toBe("projected");
  });

  it("publishReview submits a review and returns projected", async () => {
    const outcome = await makeSafe().publishReview({
      repoFullName: REPO_FULL_NAME,
      changeRequestNumber: PR_NUMBER,
      body: "Tanren review mirror.",
    });
    expect(outcome.kind).toBe("projected");
  });

  it("retargetChangeRequest re-points the base and returns projected", async () => {
    const outcome = await makeSafe().retargetChangeRequest({
      repoFullName: REPO_FULL_NAME,
      changeRequestNumber: PR_NUMBER,
      newBaseBranch: "main",
    });
    expect(outcome.kind).toBe("projected");
  });

  it("openTrackingIssue files an issue and returns the projected handle", async () => {
    const outcome = await makeSafe().openTrackingIssue({
      repoFullName: REPO_FULL_NAME,
      title: "post-merge regression",
      body: "the post-merge gate on the default branch failed",
      labels: ["regression"],
    });
    expect(outcome).toEqual({ kind: "projected", value: { url: ISSUE_URL, number: ISSUE_NUMBER } });
  });

  it("markChangeRequestReady un-drafts the PR mirror and returns projected", async () => {
    const outcome = await makeSafe().markChangeRequestReady({
      repoFullName: REPO_FULL_NAME,
      changeRequestNumber: PR_NUMBER,
    });
    expect(outcome.kind).toBe("projected");
  });

  it("a malformed repoFullName fails on the SAFE surface without rejecting", async () => {
    // The parse throws — but the hardened surface severs it into `failed`, never rejects.
    const outcome = await makeSafe().publishGate({
      repoFullName: "not-a-full-name",
      headSha: HEAD_SHA,
      verdict: "failed",
      summary: "x",
    });
    expect(outcome.kind).toBe("failed");
  });
});
