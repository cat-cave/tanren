import { parseRefObjectSha } from "../providers/githubChecksParse.js";
import { repoPath, withErrorDetail, type GitHubHttpClient, type GitHubRepository } from "../providers/github.js";
import { validateGitBranchName, type GitHubPushLease } from "../workspace/githubPush.js";

/**
 * Read the remote branch immediately before a draft/rework publication.  A 404
 * is an explicit absence proof; every other non-200 or malformed response fails
 * closed, so publication can be re-driven instead of overwriting unknown work.
 */
export async function readDraftPrPushLease(
  http: GitHubHttpClient,
  repo: GitHubRepository,
  branch: string,
  token: string,
  expectedPublishedHeadSha?: string,
): Promise<GitHubPushLease> {
  const validBranch = validateGitBranchName(branch);
  if (expectedPublishedHeadSha !== undefined && !/^[0-9a-f]{40}$/u.test(expectedPublishedHeadSha)) {
    throw new Error(`GitHub draft branch expected published head is invalid for ${validBranch}`);
  }
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/git/ref/heads/${encodeURIComponent(validBranch)}`),
    token,
    // The caller owns recovery. Do not hide a stale observation behind retries.
    retryTransient: false,
    retryRateLimit: false,
  });
  if (response.status === 404 && expectedPublishedHeadSha === undefined) return { expectedAbsent: true };
  const sha = parseRefObjectSha(response.body);
  if (response.status !== 200 || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(
      withErrorDetail(`GitHub draft branch read failed for ${validBranch}: HTTP ${response.status}`, response),
    );
  }
  if (expectedPublishedHeadSha !== undefined && sha !== expectedPublishedHeadSha) {
    throw new Error(`GitHub draft branch changed since workspace rework for ${validBranch}`);
  }
  return { expectedSha: sha };
}
