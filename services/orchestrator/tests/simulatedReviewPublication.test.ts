// Unit proofs for strict simulated-review publication helpers (gv-2):
// receipt validation, event mapping, distinct-identity credential resolution.
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import {
  assertStrictForgeReceipt,
  resolveDistinctSimulatedReviewerToken,
  SimulatedReviewPublicationError,
  strictReviewEventFor,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";

const HEAD = "d".repeat(40);

function identityHttp(loginByToken: Record<string, string>): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
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
});
