// Unit proofs for strict simulated-review publication helpers (gv-2):
// receipt validation, event mapping, distinct-identity credential resolution.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import {
  assertStrictForgeReceipt,
  resolveDistinctSimulatedReviewerToken,
  SimulatedReviewPublicationError,
  strictReviewEventFor,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";

const HEAD = "d".repeat(40);

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function identityHttp(loginByToken: Record<string, string>, appSlug = "tanren-app"): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      // App JWT identity path (resolveAppBotIdentity): GET /app → slug, then
      // GET /users/<slug>[bot] → bot-user id. Static tokens use GET /user.
      if (req.path === "/app") {
        return { status: 200, body: { slug: appSlug, id: 1 } };
      }
      if (req.path.startsWith("/users/")) {
        const login = decodeURIComponent(req.path.slice("/users/".length));
        return { status: 200, body: { login, id: 99 } };
      }
      if (req.path === "/user" || req.path.startsWith("/user?")) {
        const login = loginByToken[req.token] ?? "unknown";
        return { status: 200, body: { login, id: 42 } };
      }
      return { status: 404, body: { message: "not found" } };
    },
  };
}

describe("strictReviewEventFor", () => {
  it("maps approve → APPROVE and request_changes → REQUEST_CHANGES (never COMMENT)", () => {
    expect(strictReviewEventFor("approve")).toBe("APPROVE");
    expect(strictReviewEventFor("request_changes")).toBe("REQUEST_CHANGES");
  });
});

describe("assertStrictForgeReceipt", () => {
  it("accepts a matching exact-head APPROVE receipt", () => {
    const pub = assertStrictForgeReceipt({
      receipt: {
        forgeReviewId: "9",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-9",
        headSha: HEAD,
        reviewerLogin: "r",
      },
      expectedVerdict: "approved",
      expectedHeadSha: HEAD,
    });
    expect(pub.forgeReviewId).toBe("9");
    expect(pub.headSha).toBe(HEAD);
  });

  it("rejects head mismatch", () => {
    expect(() =>
      assertStrictForgeReceipt({
        receipt: {
          forgeReviewId: "9",
          forgeReviewState: "approved",
          forgeReviewUrl: "https://x",
          headSha: "e".repeat(40),
          reviewerLogin: "r",
        },
        expectedVerdict: "approved",
        expectedHeadSha: HEAD,
      }),
    ).toThrow(SimulatedReviewPublicationError);
  });

  it("rejects state mismatch", () => {
    expect(() =>
      assertStrictForgeReceipt({
        receipt: {
          forgeReviewId: "9",
          forgeReviewState: "changes_requested",
          forgeReviewUrl: "https://x",
          headSha: HEAD,
          reviewerLogin: "r",
        },
        expectedVerdict: "approved",
        expectedHeadSha: HEAD,
      }),
    ).toThrow(/state mismatch/u);
  });
});

describe("resolveDistinctSimulatedReviewerToken", () => {
  it("uses explicit reviewerGithubCredentialRef when it is a different login", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/writer", token: "ghp_writer_token" });
    await storeGithubToken(secrets, { ref: "credential/github/reviewer", token: "ghp_reviewer_token" });
    const http = identityHttp({
      ghp_writer_token: "writer-bot",
      ghp_reviewer_token: "reviewer-bot",
    });

    const resolved = await resolveDistinctSimulatedReviewerToken({
      secrets,
      githubHttp: http,
      writerStaticRef: "credential/github/writer",
      reviewerGithubCredentialRef: "credential/github/reviewer",
    });

    expect(resolved.writerLogin).toBe("writer-bot");
    expect(resolved.reviewerLogin).toBe("reviewer-bot");
    expect(resolved.reviewer.token).toBe("ghp_reviewer_token");
  });

  it("rejects same-identity explicit reviewer", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/same", token: "ghp_same_token" });
    const http = identityHttp({ ghp_same_token: "same-bot" });

    await expect(
      resolveDistinctSimulatedReviewerToken({
        secrets,
        githubHttp: http,
        writerStaticRef: "credential/github/same",
        reviewerGithubCredentialRef: "credential/github/same",
      }),
    ).rejects.toThrow(/same-identity/iu);
  });

  it("fails closed when only a single static credential exists (no App dual-seam)", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/only", token: "ghp_only" });
    const http = identityHttp({ ghp_only: "only-bot" });

    await expect(
      resolveDistinctSimulatedReviewerToken({
        secrets,
        githubHttp: http,
        writerStaticRef: "credential/github/only",
      }),
    ).rejects.toThrow(/distinct reviewer identity/iu);
  });

  it("production dual seam: App writer + static project/org githubCredentialRef as reviewer", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubAppCredential(secrets, {
      ref: "credential/github_app/org/o1/default",
      appId: "1",
      privateKeyPem: pem(),
    });
    await storeGithubToken(secrets, { ref: "credential/github/org/o1/default", token: "ghp_reviewer_static" });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          token: "ghs_app_writer",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      )) as unknown as typeof fetch;
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    const http = identityHttp({ ghp_reviewer_static: "reviewer-bot" }, "tanren-app");

    const resolved = await resolveDistinctSimulatedReviewerToken({
      secrets,
      githubHttp: http,
      writerInstallation: {
        installationId: "42",
        appId: "1",
        credentialRef: "credential/github_app/org/o1/default",
        installedAt: "now",
      },
      writerStaticRef: "credential/github/org/o1/default",
      githubAppMinter: minter,
    });

    // Writer is the App bot login; reviewer is the static token — never the App token.
    expect(resolved.writerLogin).toBe("tanren-app[bot]");
    expect(resolved.reviewerLogin).toBe("reviewer-bot");
    expect(resolved.reviewer.token).toBe("ghp_reviewer_static");
    expect(resolved.reviewer.source).toBe("static");
    expect(resolved.reviewer.token).not.toBe("ghs_app_writer");
    expect(resolved.reviewerLogin.toLowerCase()).not.toBe(resolved.writerLogin.toLowerCase());
  });

  it("App without static reviewer credential fails closed (never reuses writer App identity)", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubAppCredential(secrets, {
      ref: "credential/github_app/org/o1/default",
      appId: "1",
      privateKeyPem: pem(),
    });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          token: "ghs_app_writer",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      )) as unknown as typeof fetch;
    const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
    const http = identityHttp({}, "tanren-app");

    await expect(
      resolveDistinctSimulatedReviewerToken({
        secrets,
        githubHttp: http,
        writerInstallation: {
          installationId: "42",
          appId: "1",
          credentialRef: "credential/github_app/org/o1/default",
          installedAt: "now",
        },
        // No writerStaticRef / reviewerGithubCredentialRef — only the App install.
        githubAppMinter: minter,
      }),
    ).rejects.toThrow(/distinct reviewer credential|static/iu);
  });
});
