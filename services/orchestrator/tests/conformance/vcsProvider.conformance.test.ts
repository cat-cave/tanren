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

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { GitHubVcsProvider } from "../../src/engine/providers/githubVcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type { VcsProvider } from "../../src/engine/contracts/vcsProvider.js";
import { InMemoryVcsProvider } from "./fakes/inMemoryVcsProvider.js";
import {
  CONFORMANCE_ABSENT_BRANCH,
  CONFORMANCE_ACTOR_ID,
  CONFORMANCE_ACTOR_LOGIN,
  CONFORMANCE_ANCESTOR_CONFLICT,
  CONFORMANCE_BEHIND_PR_NUMBER,
  CONFORMANCE_DIRTY_PR_NUMBER,
  CONFORMANCE_EXISTING_REPO_NAME,
  CONFORMANCE_FAILING_BRANCH,
  CONFORMANCE_HEAD_BRANCH,
  CONFORMANCE_PRESENT_FILE,
  CONFORMANCE_PRESENT_FILE_BODY,
  describeVcsProviderConformance,
} from "./vcsProviderConformance.js";

const STATIC_REF = "credential/github/conformance";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
/** P2d-2: the distinct SHA the FAILING integration ref resolves to (its check-runs fail). */
const FAILING_SHA = "fa11edfa11edfa11edfa11edfa11edfa11edfa11";

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

    // resolveActorIdentity (static path): GET /user → the PAT user's login + id.
    if (input.method === "GET" && path === "/user") {
      return ok({ login: CONFORMANCE_ACTOR_LOGIN, id: Number(CONFORMANCE_ACTOR_ID) });
    }

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
      if (number === CONFORMANCE_BEHIND_PR_NUMBER)
        return { status: 202, body: { message: "Updating pull request branch." } };
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
    // retargetPullRequestBase (P2c): PATCH /pulls/:n { base } → the updated PR.
    if (input.method === "PATCH" && /\/pulls\/\d+$/u.test(path)) {
      const base = (input.body as { base?: unknown } | undefined)?.base;
      return ok({ number: 7, base: { ref: typeof base === "string" ? base : "main" } });
    }
    if (input.method === "POST" && path === "/graphql") {
      return ok({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    // readPullRequestChecks / readBranchChecks: check-runs + commit status; protection
    // 404. The FAILING integration ref's SHA reports a failed check (a bad
    // interaction — the P2d-2 batch-check signal); every other commit is green.
    if (input.method === "GET" && path.endsWith("/check-runs")) {
      if (path.includes(FAILING_SHA)) {
        return ok({ check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] });
      }
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
    // buildIntegrationBranch (P2c): resolve the base ref sha, (re)create the
    // ephemeral integration ref, then merge each ancestor branch. The conflict
    // ancestor's branch yields a 409 from the merges endpoint.
    if (input.method === "GET" && /\/git\/ref\/heads\//u.test(path)) {
      // P2c-2 readBranchHeadSha: the well-known absent branch 404s (missing ref).
      if (path.includes(encodeURIComponent(CONFORMANCE_ABSENT_BRANCH))) {
        return { status: 404, body: { message: "Not Found" } };
      }
      // P2d-2 readBranchChecks: the FAILING integration ref resolves to a SHA whose
      // check-runs fail (so the prospective merged state's CI is red).
      if (path.includes(encodeURIComponent(CONFORMANCE_FAILING_BRANCH))) {
        return ok({ object: { sha: FAILING_SHA } });
      }
      return ok({ object: { sha: HEAD_SHA } });
    }
    if (input.method === "POST" && path.endsWith("/git/refs")) {
      return { status: 201, body: { ref: "refs/heads/integ" } };
    }
    if (input.method === "PATCH" && /\/git\/refs\/heads\//u.test(path)) {
      return ok({ ref: "refs/heads/integ" });
    }
    // deleteBranch (P2c cleanup): DELETE /git/refs/heads/:branch → 204.
    if (input.method === "DELETE" && /\/git\/refs\/heads\//u.test(path)) {
      return { status: 204, body: {} };
    }
    if (input.method === "POST" && path.endsWith("/merges")) {
      const head = (input.body as { head?: unknown } | undefined)?.head;
      if (head === CONFORMANCE_ANCESTOR_CONFLICT.branch) return { status: 409, body: { message: "Merge conflict" } };
      return { status: 201, body: { sha: "integ-merge-sha" } };
    }
    // createRepository (GREENFIELD): POST /orgs/:owner/repos. The taken name 422s
    // (already-exists → typed error); any other name creates (201) with the real
    // full_name/html_url/default_branch the auto_init seeded.
    if (input.method === "POST" && /^\/orgs\/[^/]+\/repos$/u.test(path)) {
      const name = (input.body as { name?: unknown } | undefined)?.name;
      if (name === CONFORMANCE_EXISTING_REPO_NAME) {
        return { status: 422, body: { message: "name already exists on this account" } };
      }
      return {
        status: 201,
        body: {
          full_name: `cat-cave/${typeof name === "string" ? name : "repo"}`,
          html_url: `https://github.com/cat-cave/${typeof name === "string" ? name : "repo"}`,
          default_branch: "main",
        },
      };
    }
    // createIssue: POST /issues → 201 with the issue number + html_url.
    if (input.method === "POST" && path.endsWith("/issues")) {
      return {
        status: 201,
        body: { number: 42, html_url: "https://github.com/cat-cave/tanren-conformance/issues/42" },
      };
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

// MERGE-SAFETY (self-identity) — App path: an installation token resolves the
// App's bot identity `<app-slug>[bot]` via GET /app (slug, signed with the App
// JWT), then the BOT-USER id via GET /users/<slug>[bot] — and the noreply email
// MUST key off the bot-user id, NOT the App id (a different number; the App id
// does not attribute commits to the bot). The static path is covered by the
// generic suite above; the App path needs an App credential + installation context.
describe("GitHubVcsProvider.resolveActorIdentity (App installation path)", () => {
  // The App id and the bot-user id are DELIBERATELY different numbers so this test
  // FAILS if the noreply is built from the App id instead of the bot-user id.
  const APP_ID = 555000;
  const BOT_USER_ID = 987654;

  it("resolves <slug>[bot] + a noreply email keyed on the BOT-USER id (GET /users/<slug>[bot]), not the App id", async () => {
    // A scripted transport: GET /app → slug + App id; GET /users/<slug>[bot] → the
    // (distinct) bot-user id.
    class AppRoutingHttp implements GitHubHttpClient {
      async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
        if (input.method === "GET" && input.path === "/app") {
          return { status: 200, body: { slug: "tanren-bot", id: APP_ID } };
        }
        if (input.method === "GET" && input.path === `/users/${encodeURIComponent("tanren-bot[bot]")}`) {
          return { status: 200, body: { login: "tanren-bot[bot]", id: BOT_USER_ID } };
        }
        throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
      }
    }
    const secrets = new InMemorySecretStore();
    const appRef = "credential/github_app/conformance";
    // A throwaway RSA key so signAppJwt (inside resolveActorIdentity) has a real PEM.
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await secrets.put({ ref: appRef, value: JSON.stringify({ appId: String(APP_ID), privateKeyPem }) });

    const provider = new GitHubVcsProvider(new AppRoutingHttp());
    // An App installation token (source github_app) carrying the installation context.
    const token = await provider.resolveToken({
      secrets,
      installation: {
        appId: String(APP_ID),
        installationId: "99",
        credentialRef: appRef,
        installedAt: "2026-01-01T00:00:00Z",
      },
      // A minter that returns a fixed installation token without a network mint.
      minter: {
        getInstallationToken: async () => "ghs_appToken",
        refreshInstallationToken: async () => "ghs_appToken",
      } as never,
    });
    expect(token.source).toBe("github_app");

    const actor = await provider.resolveActorIdentity(token);
    expect(actor.login).toBe("tanren-bot[bot]");
    // The id + noreply key off the BOT-USER id, NOT the App id — using the App id
    // (`${APP_ID}+…`) here would leave the PR-commit author `null` → `<unknown>`.
    expect(actor.id).toBe(String(BOT_USER_ID));
    expect(actor.noreplyEmail).toBe(`${BOT_USER_ID}+tanren-bot[bot]@users.noreply.github.com`);
    expect(actor.noreplyEmail).not.toContain(String(APP_ID));
  });
});
