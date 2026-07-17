import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  GithubReviewerAppIdentity,
  ReviewerAppNotConfiguredError,
} from "../src/engine/governance/githubReviewerAppIdentity.js";
import type { GitHubHttpClient, GitHubHttpRequest } from "../src/engine/providers/github.js";
import type { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";

function poolWithOrgConfig(config: unknown): pg.Pool {
  const query = async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT config FROM organizations")) return { rows: [{ config }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

describe("GithubReviewerAppIdentity", () => {
  it("uses the installed Reviewer App token to attest the repository visibility and exact head", async () => {
    const requests: GitHubHttpRequest[] = [];
    const http: GitHubHttpClient = {
      request: async (input) => {
        requests.push(input);
        if (input.path === "/repos/example/private-repo") {
          return { status: 200, body: { private: true, default_branch: "main" } };
        }
        if (input.path === "/repos/example/private-repo/commits/main") {
          return { status: 200, body: { sha: "deadbeef" } };
        }
        throw new Error(`unexpected GitHub request: ${input.path}`);
      },
    };
    const minter = {
      getInstallationToken: async () => "reviewer-app-token",
      refreshInstallationToken: async () => "reviewer-app-token-refreshed",
    } as unknown as GithubAppTokenMinter;
    const identity = new GithubReviewerAppIdentity({
      pool: poolWithOrgConfig({
        version: 1,
        github_app: {
          installationId: "reviewer-installation",
          appId: "reviewer-app",
          credentialRef: "credential/github_app/org/org_reviewer/default",
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
      secrets: {} as never,
      http,
      minter,
    });

    await expect(
      identity.readRepositoryVisibility({
        orgId: "org_reviewer",
        repoUrl: "https://github.com/example/private-repo.git",
      }),
    ).resolves.toEqual({ observedVisibility: "private", forgeRef: "github:example/private-repo", sha: "deadbeef" });
    expect(requests.map((request) => request.path)).toEqual([
      "/repos/example/private-repo",
      "/repos/example/private-repo/commits/main",
    ]);
    expect(requests.every((request) => request.token === "reviewer-app-token")).toBe(true);
  });

  it("fails closed when the organization has no Reviewer-App installation", async () => {
    const identity = new GithubReviewerAppIdentity({
      pool: poolWithOrgConfig({ version: 1 }),
      secrets: {} as never,
      http: {
        request: async () => {
          throw new Error("a Reviewer-App read must not fall back to another credential");
        },
      },
    });

    await expect(
      identity.readRepositoryVisibility({
        orgId: "org_without_app",
        repoUrl: "https://github.com/example/private-repo.git",
      }),
    ).rejects.toBeInstanceOf(ReviewerAppNotConfiguredError);
  });
});
