// Per-implementation invocation of the VcsProvider conformance suite. The SAME
// behavior spec runs against:
//   1. The PRODUCTION `GitHubVcsProvider`, over a scripted HTTP transport that
//      answers each lifecycle endpoint the contract exercises (so the real
//      provider's wrapping of the GitHub services + token resolver is pinned by
//      the contract, without hitting real GitHub).
//   2. A purely in-memory `InMemoryVcsProvider` fake — proving the suite pins
//      the CONTRACT, not a GitHub-shaped transport.
// The scripted transport + the in-memory fake are test fixtures (they live HERE,
// under tests/, never in src/). The pg/live behaviors are integration-tested
// against the live stack; this suite is the behavioral contract every
// VcsProvider impl must satisfy without a database or network.

import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { GitHubVcsProvider } from "../../src/engine/providers/githubVcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type { VcsProvider } from "../../src/engine/contracts/vcsProvider.js";
import { InMemoryVcsProvider } from "./fakes/inMemoryVcsProvider.js";
import {
  CONFORMANCE_BEHIND_PR_NUMBER,
  CONFORMANCE_DIRTY_PR_NUMBER,
  CONFORMANCE_HEAD_BRANCH,
  CONFORMANCE_PRESENT_FILE,
  CONFORMANCE_PRESENT_FILE_BODY,
  describeVcsProviderConformance,
} from "./vcsProviderConformance.js";

const STATIC_REF = "credential/github/conformance";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ok = (body: unknown): GitHubHttpResponse => ({ status: 200, body });

/**
 * A scripted GitHub HTTP transport that routes on method + path so a single
 * provider can drive every conformance operation against it (unlike a
 * sequential response queue, the suite calls operations in any order). Only the
 * fields the provider/contract reads are populated.
 */
class RoutingGitHubHttp implements GitHubHttpClient {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const path = input.path.split("?")[0] ?? input.path;

    // openDraftPullRequest: list (no open PR) then create (201).
    if (input.method === "GET" && path.endsWith("/pulls")) return ok([]);
    if (input.method === "POST" && path.endsWith("/pulls")) {
      return {
        status: 201,
        body: { number: 7, html_url: "https://github.com/cat-cave/tanren-conformance/pull/7", draft: true },
      };
    }
    // mergePullRequest: PR 9 conflicts (409); everything else merges (200).
    if (input.method === "PUT" && path.endsWith("/pulls/9/merge")) {
      return { status: 409, body: { message: "merge conflict" } };
    }
    if (input.method === "PUT" && path.endsWith("/merge")) return ok({ sha: "merge-sha", merged: true });
    // updateBranch (P2a): the behind PR is accepted (202); the dirty PR conflicts
    // (422); any other PR is already current (204).
    const updateMatch = /\/pulls\/(\d+)\/update-branch$/u.exec(path);
    if (input.method === "PUT" && updateMatch !== null) {
      const number = Number(updateMatch[1]);
      if (number === CONFORMANCE_BEHIND_PR_NUMBER) return { status: 202, body: { message: "Updating pull request branch." } };
      if (number === CONFORMANCE_DIRTY_PR_NUMBER) return { status: 422, body: { message: "merge conflict" } };
      return { status: 204, body: {} };
    }
    // PR detail GET (P2a mergeability + markReadyForReview node id): vary
    // mergeable_state by PR number — the behind PR is `behind`, the dirty PR is
    // `dirty`, everything else `clean`.
    const detailMatch = /\/pulls\/(\d+)$/u.exec(path);
    if (input.method === "GET" && detailMatch !== null) {
      const number = Number(detailMatch[1]);
      const mergeableState =
        number === CONFORMANCE_BEHIND_PR_NUMBER ? "behind" : number === CONFORMANCE_DIRTY_PR_NUMBER ? "dirty" : "clean";
      return ok({
        node_id: "PR_node_7",
        head: { sha: HEAD_SHA, ref: CONFORMANCE_HEAD_BRANCH },
        base: { ref: "main" },
        mergeable_state: mergeableState,
      });
    }
    if (input.method === "POST" && path === "/graphql") {
      return ok({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    // readPullRequestChecks: check-runs + commit status; protection 404.
    if (input.method === "GET" && path.endsWith("/check-runs")) {
      return ok({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    }
    if (input.method === "GET" && path.endsWith("/status")) return ok({ statuses: [] });
    if (input.method === "GET" && path.endsWith("/required_status_checks")) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    // readReviewVerdict.
    if (input.method === "GET" && path.endsWith("/reviews")) {
      return ok([{ state: "APPROVED", user: { login: "bot" } }]);
    }
    // readPullRequestDiff.
    if (input.method === "GET" && path.endsWith("/files")) {
      return ok([{ filename: "a.txt", patch: "@@ -1 +1 @@\n-x\n+y" }]);
    }
    // listContributors.
    if (input.method === "GET" && path.endsWith("/commits")) {
      return ok([{ author: { login: "author-bot" }, committer: { login: "author-bot" } }]);
    }
    // readFileOnBranch: present file → base64 content; everything else 404.
    if (input.method === "GET" && path.includes(`/contents/${CONFORMANCE_PRESENT_FILE}`)) {
      return ok({ content: Buffer.from(CONFORMANCE_PRESENT_FILE_BODY, "utf8").toString("base64"), encoding: "base64" });
    }
    if (input.method === "GET" && path.includes("/contents/")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

function gitHubProviderHarness(): { make(): VcsProvider; creds(): Parameters<VcsProvider["resolveToken"]>[0] } {
  return {
    make: (): VcsProvider => new GitHubVcsProvider(new RoutingGitHubHttp()),
    creds: () => {
      const secrets = new InMemorySecretStore();
      void secrets.put({ ref: STATIC_REF, value: "ghp_conformanceToken" });
      return { secrets, staticRef: STATIC_REF };
    },
  };
}

describeVcsProviderConformance("GitHubVcsProvider", gitHubProviderHarness());

describeVcsProviderConformance("InMemoryVcsProvider", {
  make: (): VcsProvider => new InMemoryVcsProvider(),
  creds: () => ({ secrets: new InMemorySecretStore(), staticRef: STATIC_REF }),
});
