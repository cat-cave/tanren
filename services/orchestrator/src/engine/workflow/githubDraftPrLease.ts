import { repoPath, withErrorDetail, type GitHubHttpClient, type GitHubRepository } from "../providers/github.js";

export type DraftBranchLease = { expectedSha: string } | { expectedAbsent: true };

/** Read the forge head immediately before a draft-branch write; never permit a blind force. */
export async function readDraftBranchLease(
  http: GitHubHttpClient,
  repo: GitHubRepository,
  branch: string,
  token: string,
  refresh?: () => Promise<string>,
): Promise<DraftBranchLease> {
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/git/ref/heads/${encodeURIComponent(branch)}`),
    token,
    ...(refresh !== undefined && { refreshToken: refresh }),
  });
  if (response.status === 404) return { expectedAbsent: true };
  const sha =
    typeof response.body === "object" && response.body !== null
      ? (response.body as { object?: { sha?: unknown } }).object?.sha
      : undefined;
  if (response.status !== 200 || typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(
      withErrorDetail(`GitHub draft branch read failed for ${branch}: HTTP ${response.status}`, response),
    );
  }
  return { expectedSha: sha };
}
