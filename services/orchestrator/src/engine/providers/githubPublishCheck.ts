// Track B (no-Actions doctrine, `docs/roadmap/tanren-direction.md`): the GitHub
// native check-run + commit-status PUBLISH flow, extracted from
// `githubVcsProvider.ts` so the provider stays under the per-file line cap. These
// are how Tanren PUBLISHES its own gate verdict to the forge (the Checks API
// check-run + the lower-friction commit status), the additive complement to the
// READ-only check polling the run loop does today.
//
// SECURITY: the resolved token is passed to the HTTP client as the auth header
// only; it is NEVER placed in a path, a body, a log, or a returned value. The
// payloads carry only non-secret, operator/code-controlled fields.

import type { GitHubHttpClient } from "./github.js";
import type { PublishCheckInput, PublishedCheck, PublishStatusInput } from "../contracts/vcsProvider.js";

function repoPath(owner: string, name: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

/**
 * Publish a Tanren-native CHECK-RUN via `POST /repos/{o}/{r}/check-runs`. A
 * published check is always `status: completed` carrying the terminal
 * `conclusion`; `output` carries the title/summary the PR check-detail renders,
 * and any inline annotations (mapped to GitHub's `output.annotations` shape). A
 * 201 is the success; anything else is a LOUD throw naming the status (no token).
 */
export async function publishGitHubCheck(http: GitHubHttpClient, input: PublishCheckInput): Promise<PublishedCheck> {
  const output: Record<string, unknown> = {
    title: input.title,
    summary: input.summary,
    ...(input.annotations !== undefined &&
      input.annotations.length > 0 && {
        annotations: input.annotations.map((a) => ({
          path: a.path,
          start_line: a.startLine,
          end_line: a.endLine,
          annotation_level: a.annotationLevel,
          message: a.message,
          ...(a.title !== undefined && { title: a.title }),
        })),
      }),
  };
  const response = await http.request({
    method: "POST",
    path: repoPath(input.repo.owner, input.repo.name, "/check-runs"),
    token: input.token.token,
    refreshToken: input.token.refresh,
    body: {
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      ...(input.detailsUrl !== undefined && { details_url: input.detailsUrl }),
      output,
    },
  });
  if (response.status !== 201 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`GitHub check-run publish failed: HTTP ${response.status}`);
  }
  const body = response.body as { id?: unknown; html_url?: unknown };
  if (typeof body.id !== "number" || typeof body.html_url !== "string") {
    throw new TypeError("GitHub check-run publish returned no id/url");
  }
  return { id: body.id, url: body.html_url };
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
