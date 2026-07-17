import type { GitHubPullRequest, GitHubPullRequestHead, GitHubRepository } from "../github.js";

export function parseGitHubRepository(repoUrl: string): GitHubRepository {
  const httpsMatch = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(repoUrl);
  if (httpsMatch !== null) {
    return { owner: httpsMatch[1] ?? "", name: httpsMatch[2] ?? "" };
  }
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(repoUrl);
  if (sshMatch !== null) {
    return { owner: sshMatch[1] ?? "", name: sshMatch[2] ?? "" };
  }
  throw new Error(`unsupported GitHub repository URL: ${repoUrl}`);
}

export function parseGitHubPullRequestUrl(prUrl: string): {
  repo: GitHubRepository;
  pullNumber: number;
} {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(prUrl);
  if (match === null) {
    throw new Error(`unsupported GitHub pull request URL: ${prUrl}`);
  }
  return { repo: { owner: match[1] ?? "", name: match[2] ?? "" }, pullNumber: Number(match[3]) };
}

export function githubHttpsRemote(repo: GitHubRepository): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

export function repoPath(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

export function parsePullRequest(value: unknown): GitHubPullRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["number"] !== "number" || typeof object["html_url"] !== "string") {
    throw new TypeError("GitHub PR response missing number or html_url");
  }
  return {
    number: object["number"],
    url: object["html_url"],
    draft: object["draft"] === true,
    baseBranch: parseBaseBranch(object["base"]),
  };
}

export function asPullArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub PR lookup response was not an array");
  }
  return value;
}

export function parseBaseBranch(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const ref = (value as Record<string, unknown>)["ref"];
  return typeof ref === "string" ? ref : undefined;
}

export function parsePullRequestHead(value: unknown): GitHubPullRequestHead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const head = (value as Record<string, unknown>)["head"];
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    throw new Error("GitHub PR response missing head");
  }
  const object = head as Record<string, unknown>;
  if (typeof object["sha"] !== "string" || object["sha"] === "") {
    throw new Error("GitHub PR response missing head sha");
  }
  return { sha: object["sha"], ref: typeof object["ref"] === "string" ? object["ref"] : undefined };
}
