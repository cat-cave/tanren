// Per-implementation invocation of the (residual) VcsProvider conformance suite.
// The SAME behavior spec runs against:
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

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { GitHubVcsProvider } from "../../src/engine/providers/githubVcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type { VcsProvider } from "../../src/engine/contracts/vcsProvider.js";
import { InMemoryVcsProvider } from "./fakes/inMemoryVcsProvider.js";
import {
  CONFORMANCE_ACTOR_ID,
  CONFORMANCE_ACTOR_LOGIN,
  CONFORMANCE_FAILING_BRANCH,
  describeVcsProviderConformance,
} from "./vcsProviderConformance.js";

const STATIC_REF = "credential/github/conformance";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
/** the distinct SHA the FAILING base ref resolves to (its check-runs fail). */
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
    // readBranchChecks: check-runs + commit status; protection 404. The FAILING
    // base ref's SHA reports a failed check (a post-merge regression); every
    // other commit is green.
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
    // readBranchChecks resolves a branch's HEAD sha: the FAILING base ref resolves
    // to a SHA whose check-runs fail (so its CI is red).
    if (input.method === "GET" && /\/git\/ref\/heads\//u.test(path)) {
      if (path.includes(encodeURIComponent(CONFORMANCE_FAILING_BRANCH))) {
        return ok({ object: { sha: FAILING_SHA } });
      }
      return ok({ object: { sha: HEAD_SHA } });
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
