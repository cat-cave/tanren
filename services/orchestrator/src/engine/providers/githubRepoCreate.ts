// GREENFIELD: the GitHub repository-CREATE flow (`POST /orgs/{owner}/repos`),
// extracted from `githubVcsProvider.ts` so the provider stays under the per-file
// line cap. It mirrors the shape of the other GitHub side-effect helpers
// (`actionsSecretSeal.ts`): a single function over the injected `GitHubHttpClient`
// that performs the call, maps the documented error statuses onto the contract's
// typed errors, and returns the contract's neutral result. The token travels only
// in the request's auth header (never in a body, a log, or a thrown message).

import {
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
  type CreateRepositoryInput,
  type CreatedRepository,
  type ResolvedVcsToken,
} from "../contracts/vcsProvider.js";
import type { GitHubHttpClient } from "./github.js";

/**
 * Create an ORG-owned repository on GitHub. `auto_init: true` (from
 * `input.autoInit`) seeds an initial commit so the repo is immediately cloneable
 * and carries a `default_branch`. The plaintext token is passed only as the
 * request token (the HTTP client puts it in the `Authorization` header); it never
 * appears in the body or in any error this raises.
 *
 * Error mapping (documented GitHub statuses):
 *   - 422 ⇒ the name is already taken under the owner → {@link RepositoryAlreadyExistsError}.
 *   - 403 ⇒ the credential lacks `administration: write` (the App installation
 *           was not granted repo-creation) → {@link RepositoryCreationForbiddenError}.
 * Both are TYPED + recoverable so the route maps them to clean 409/403 responses
 * — never a stack trace, never a leaked token.
 */
export async function createGitHubRepository(
  http: GitHubHttpClient,
  input: CreateRepositoryInput,
  token: ResolvedVcsToken,
): Promise<CreatedRepository> {
  const response = await http.request({
    method: "POST",
    path: `/orgs/${encodeURIComponent(input.owner)}/repos`,
    token: token.token,
    refreshToken: token.refresh,
    body: {
      name: input.name,
      private: input.private,
      auto_init: input.autoInit,
      ...(input.description !== undefined && input.description.length > 0 && { description: input.description }),
    },
  });

  if (response.status === 422) {
    throw new RepositoryAlreadyExistsError(input.owner, input.name);
  }
  if (response.status === 403) {
    throw new RepositoryCreationForbiddenError(input.owner);
  }
  if (response.status !== 201 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`GitHub repository create failed: HTTP ${response.status}`);
  }

  const body = response.body as { full_name?: unknown; html_url?: unknown; default_branch?: unknown };
  if (
    typeof body.full_name !== "string" ||
    typeof body.html_url !== "string" ||
    typeof body.default_branch !== "string"
  ) {
    throw new TypeError("GitHub repository create returned no full_name/html_url/default_branch");
  }
  return { fullName: body.full_name, repoUrl: body.html_url, defaultBranch: body.default_branch };
}
