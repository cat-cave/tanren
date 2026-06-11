import type { PullRequestRef, RepoRef, ResolvedVcsToken } from "../contracts/codeHostTypes.js";
import type { GitHubHttpClient, GitHubHttpResponse } from "./github.js";

function repoApiPath(repo: RepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function bodyMessage(response: GitHubHttpResponse): string {
  const message =
    typeof response.body === "object" &&
    response.body !== null &&
    typeof (response.body as { message?: unknown }).message === "string"
      ? (response.body as { message: string }).message
      : "";
  return message === "" ? "" : `: ${message}`;
}

function prBaseRef(response: GitHubHttpResponse): unknown {
  return typeof response.body === "object" && response.body !== null
    ? (response.body as { base?: { ref?: unknown } }).base?.ref
    : undefined;
}

function observedBaseMessage(baseRef: unknown): string {
  return typeof baseRef === "string" ? `; observed base ${baseRef}` : "";
}

export async function retargetGithubPullRequestBase(input: {
  http: GitHubHttpClient;
  pr: PullRequestRef;
  newBase: string;
  token: ResolvedVcsToken;
}): Promise<void> {
  const path = repoApiPath(input.pr.repo, `/pulls/${input.pr.number}`);
  const response = await input.http.request({
    method: "PATCH",
    path,
    token: input.token.token,
    refreshToken: input.token.refresh,
    body: { base: input.newBase },
  });
  if (response.status === 200) return;
  if (response.status === 422) {
    const reread = await input.http.request({
      method: "GET",
      path,
      token: input.token.token,
      refreshToken: input.token.refresh,
    });
    const baseRef = prBaseRef(reread);
    if (reread.status === 200 && baseRef === input.newBase) return;
    throw new Error(
      `GitHub PR base retarget to ${input.newBase} failed: HTTP 422${bodyMessage(response)}; reconcile GET HTTP ${reread.status}${observedBaseMessage(baseRef)}`,
    );
  }
  throw new Error(
    `GitHub PR base retarget to ${input.newBase} failed: HTTP ${response.status}${bodyMessage(response)}`,
  );
}
