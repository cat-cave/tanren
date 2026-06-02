/**
 * Typed errors for the {@link import("./vcsProvider.js").VcsProvider} contract.
 * Extracted from `vcsProvider.ts` so that module stays the contract surface (and
 * under the per-file line cap) rather than carrying a cluster of error
 * subclasses (max-classes-per-file). Re-exported from `vcsProvider.ts` so callers
 * import them from the contract module unchanged.
 *
 * Every error carries provider-neutral REFS ONLY (owner/name) — never a token or
 * any secret value — so they are safe to surface in a route response or a log.
 */

/**
 * GREENFIELD: a repository with this name already exists under the owner (GitHub
 * 422 on `POST /orgs/{owner}/repos`). A typed, recoverable signal so the route
 * maps it to a clean 409 rather than a stack trace. Carries `owner`/`repoName`
 * refs ONLY — never a token.
 */
export class RepositoryAlreadyExistsError extends Error {
  constructor(
    readonly owner: string,
    readonly repoName: string,
  ) {
    super(`repository already exists: ${owner}/${repoName}`);
    this.name = "RepositoryAlreadyExistsError";
  }
}

/**
 * GREENFIELD: the credential is not permitted to create a repository under the
 * owner (GitHub 403 — the App installation lacks `administration: write`). A
 * typed, actionable signal so the route maps it to a clean 403 telling the
 * operator to grant the permission, NOT a leaked token or a stack trace. Carries
 * the `owner` ref ONLY.
 */
export class RepositoryCreationForbiddenError extends Error {
  constructor(readonly owner: string) {
    super(
      `not permitted to create a repository under ${owner}: the GitHub App installation likely lacks the "administration: write" permission`,
    );
    this.name = "RepositoryCreationForbiddenError";
  }
}
