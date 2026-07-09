/**
 * The repo-host self-identity type + the greenfield repo-create errors + the
 * `/contents` base64 decoder. Re-exported from `codeHostTypes.ts` so callers import
 * them from one contract module unchanged. (A sibling of the neutral run/merge shapes
 * so that module stays under the per-file line cap and free of a max-classes-per-file
 * cluster.)
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
 * Re-exported from `codeHostTypes.ts` so callers import it from one contract module.
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
 * `codeHostTypes.ts`) so the decode policy lives with the seam, under the line cap.
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

/**
 * GREENFIELD RE-ATTACH GUARD (apex v84): the derive tried to RE-ATTACH to a repo
 * that already exists (a `RepositoryAlreadyExistsError` on create) — but the repo
 * is NOT the stranded, empty auto_init seed the re-attach idempotency intends. It
 * already carries content/history from a PRIOR derive run (a `tanren compose:`
 * commit / commits beyond the bare initial one). Silently reusing it pushes the new
 * run's compose commits on top of the old scaffold, causing a cross-run BASE
 * DIVERGENCE that later fails the "prepare clean PR branch" step with an opaque
 * `WorkspaceCommandError`. Fail LOUD instead: Tanren must NOT auto-clean/force-reset
 * a repo it did not create THIS run (that would destroy operator data — same reason
 * the re-attach path registers no delete compensation). Carries `owner`/`repoName`
 * refs ONLY. The route maps it to a clean 409 `greenfield_repo_not_empty`.
 */
export class GreenfieldRepoNotEmptyError extends Error {
  constructor(
    readonly owner: string,
    readonly repoName: string,
  ) {
    super(
      `greenfield target repo ${owner}/${repoName} already contains content from a prior derive; ` +
        `choose a unique project name or delete the repo`,
    );
    this.name = "GreenfieldRepoNotEmptyError";
  }
}
