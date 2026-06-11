// Track B (no-Actions doctrine): the GitHub native commit-status PUBLISH flow — how
// Tanren PUBLISHES its own gate verdict to the forge (the `tanren/gate` commit
// status). The check-run publisher it once also carried was removed by the
// VcsProvider→CodeHost decomposition (the live publisher uses STATUS, not check-runs).
//
// SECURITY: the resolved token is passed to the HTTP client as the auth header
// only; it is NEVER placed in a path, a body, a log, or a returned value. The
// payloads carry only non-secret, operator/code-controlled fields.

import type { GitHubHttpClient } from "./github.js";
import type { PublishStatusInput } from "../contracts/vcsProvider.js";

// Re-export the publish payload type so the projection imports the publish FUNCTION
// and its TYPE from this single module (one fewer cross-module dependency there).
export type { PublishStatusInput } from "../contracts/vcsProvider.js";

function repoPath(owner: string, name: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

/**
 * Publish a Tanren-native COMMIT STATUS via `POST /repos/{o}/{r}/statuses/{sha}`
 * (the same primitive the `github_checks` notification channel posts). A 201 is
 * the success; anything else is a LOUD throw naming the status (the token never
 * appears in the error).
 */
export async function publishGitHubStatus(http: GitHubHttpClient, input: PublishStatusInput): Promise<void> {
  const response = await http.request({
    method: "POST",
    path: repoPath(input.repo.owner, input.repo.name, `/statuses/${encodeURIComponent(input.headSha)}`),
    token: input.token.token,
    refreshToken: input.token.refresh,
    body: {
      state: input.state,
      context: input.context,
      description: input.description,
      ...(input.targetUrl !== undefined && { target_url: input.targetUrl }),
    },
  });
  if (response.status !== 201) {
    throw new Error(`GitHub status publish failed: HTTP ${response.status}`);
  }
}
