// GREENFIELD: the GitHub repository-CREATE flow (`POST /orgs/{owner}/repos`)
// + the DERIVE-ROLLBACK repository-DELETE flow (`DELETE /repos/{owner}/{name}`),
// extracted so the GitHub repo-create surface stays under the per-file
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
} from "../contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "./github.js";

/**
 * The MINIMAL push credential the create needs: the plaintext token + an optional
 * 401 re-mint. A `ResolvedVcsToken` structurally satisfies this (the VcsProvider
 * caller passes one); the token-free `CodeHost` seam passes its own minimal shape
 * — so neither caller has to fabricate a `source` it does not have.
 */
export interface RepoCreateToken {
  token: string;
  refresh?: () => Promise<string>;
}

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
  token: RepoCreateToken,
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

/**
 * DELETE a repository on GitHub (`DELETE /repos/{owner}/{name}`) — the COMPENSATION
 * primitive the derive transactional rollback uses (task #78). IDEMPOTENT — a 404
 * is treated as a successful no-op (the rollback semantic is "ensure this is
 * gone"); other failure statuses (403, 5xx) propagate LOUD so the caller can
 * record + surface the rollback gap. The plaintext token travels only in the
 * request auth header (never echoed into the thrown message). The App
 * installation needs `administration: write` scope (the same scope that grants
 * repo-create), so a 403 here means the credential cannot delete what it
 * created — surfaced as a typed `RepositoryDeletionForbiddenError`.
 *
 * NEVER call from the regular run path. Repo deletion is irreversible — this
 * primitive exists ONLY to compensate for a derive that partially created
 * external resources and must walk them all back atomically.
 */
export async function deleteGitHubRepository(
  http: GitHubHttpClient,
  repo: { owner: string; name: string },
  token: RepoCreateToken,
): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    token: token.token,
    refreshToken: token.refresh,
  });
  // 204 No Content ⇒ deleted; 404 ⇒ already gone (the rollback is satisfied).
  if (response.status === 204 || response.status === 404) {
    return;
  }
  if (response.status === 403) {
    throw new RepositoryDeletionForbiddenError(repo.owner, repo.name);
  }
  throw new Error(`GitHub repository delete failed for ${repo.owner}/${repo.name}: HTTP ${response.status}`);
}

/**
 * The credential lacks `administration: write` (the App installation was not
 * granted repo-deletion). TYPED so the compensation walker can record + surface
 * a rollback gap LOUD — never silently leaving an orphan in place. Mirrors
 * `RepositoryCreationForbiddenError`.
 */
export class RepositoryDeletionForbiddenError extends Error {
  constructor(
    readonly owner: string,
    readonly repoName: string,
  ) {
    super(
      `GitHub repository delete forbidden for ${owner}/${repoName} — the credential lacks ` +
        `administration:write (cannot delete the repo it created).`,
    );
    this.name = "RepositoryDeletionForbiddenError";
  }
}
