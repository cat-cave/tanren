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

import { Buffer } from "node:buffer";

/**
 * MERGE-SAFETY (self-identity): the identity Tanren PUSHES as, from the ACTIVE
 * credential. `login` is the GitHub login Tanren's commits attribute to (the PAT
 * user, or `<app-slug>[bot]`); `id` is the numeric account id; `noreplyEmail` is
 * the canonical `<id>+<login>@users.noreply.github.com` — set as the runner's git
 * `user.email` so GitHub maps each commit back to `login` (PR-commits author
 * populated), keeping the external-change gate from keying Tanren's work `<unknown>`.
 * Re-exported from `vcsProvider.ts` so the contract surface stays under the line cap.
 */
export interface ActorIdentity {
  login: string;
  id: string;
  noreplyEmail: string;
}

/**
 * Decode a forge `/contents` response body's base64 content to a UTF-8 string.
 * Shared by the GitHub impl (and any future provider whose contents read is
 * base64-encoded). Lives in this contract-sibling module (re-exported from
 * `vcsProvider.ts`) so the decode policy lives with the seam, under the line cap.
 */
export function decodeBase64Content(content: string): string {
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
}

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
