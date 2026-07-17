import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import { loadOrgGithubAppInstallation } from "../credentials/orgGithubApp.js";
import { resolveGithubToken } from "../credentials/githubTokenResolver.js";
import { parseGitHubRepository, repoPath, type GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import {
  RepositoryVisibility,
  type RepositoryVisibility as RepositoryVisibilityValue,
} from "../repositories/repositoryVisibilityObservations.js";
import type { RepositoryVisibilityReadback, ReviewerAppIdentity } from "./repoVisibility.js";

export class ReviewerAppNotConfiguredError extends Error {
  override readonly name = "ReviewerAppNotConfiguredError";

  constructor(orgId: string) {
    super(
      `organization ${orgId} has no GitHub Reviewer-App installation configured for repository visibility readback`,
    );
  }
}

export interface GithubReviewerAppIdentityOptions {
  readonly pool: pg.Pool;
  readonly secrets: SecretStore;
  readonly http: GitHubHttpClient;
  readonly minter?: GithubAppTokenMinter;
}

/**
 * A read-only GitHub identity deliberately authenticated only as the org's App
 * installation. Visibility proof must not silently fall back to a human PAT.
 */
export class GithubReviewerAppIdentity implements ReviewerAppIdentity {
  constructor(private readonly options: GithubReviewerAppIdentityOptions) {}

  async readRepositoryVisibility(input: { orgId: string; repoUrl: string }): Promise<RepositoryVisibilityReadback> {
    const installation = await loadOrgGithubAppInstallation(this.options.pool, input.orgId);
    if (installation === undefined) {
      throw new ReviewerAppNotConfiguredError(input.orgId);
    }
    const token = await resolveGithubToken({
      secrets: this.options.secrets,
      orgId: input.orgId,
      installation,
      ...(this.options.minter === undefined ? {} : { minter: this.options.minter }),
    });
    const repo = parseGitHubRepository(input.repoUrl);
    const repository = await this.options.http.request({
      method: "GET",
      path: repoPath(repo, ""),
      token: token.token,
      refreshToken: token.refresh,
    });
    if (repository.status !== 200) {
      throw new Error(`GitHub Reviewer-App repository visibility read failed: HTTP ${repository.status}`);
    }
    const body = objectBody(repository.body, "repository visibility");
    const observedVisibility = parseVisibility(body);
    const defaultBranch = nonEmptyString(body["default_branch"], "repository default_branch");
    const commit = await this.options.http.request({
      method: "GET",
      path: repoPath(repo, `/commits/${encodeURIComponent(defaultBranch)}`),
      token: token.token,
      refreshToken: token.refresh,
    });
    if (commit.status !== 200) {
      throw new Error(`GitHub Reviewer-App repository head read failed: HTTP ${commit.status}`);
    }
    const sha = nonEmptyString(objectBody(commit.body, "repository head")["sha"], "repository head sha");
    return { observedVisibility, forgeRef: `github:${repo.owner}/${repo.name}`, sha };
  }
}

function objectBody(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`GitHub Reviewer-App ${label} response was not an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`GitHub Reviewer-App ${label} was missing`);
  }
  return value;
}

function parseVisibility(body: Record<string, unknown>): RepositoryVisibilityValue {
  const visibility = body["visibility"];
  if (visibility === "public" || visibility === "private") {
    return RepositoryVisibility.parse(visibility);
  }
  if (typeof body["private"] === "boolean") {
    return body["private"] ? "private" : "public";
  }
  throw new TypeError("GitHub Reviewer-App repository response had no visibility/private field");
}
