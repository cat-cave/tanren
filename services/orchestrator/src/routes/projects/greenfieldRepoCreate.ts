// GREENFIELD repo-create — the credential-resolve + `CodeHost.createRepo` step
// (decomposition PR-3), extracted from `greenfield.ts` so that file stays under the
// per-file dependency cap. An end user posts a greenfield project with NO repoUrl and
// Tanren creates a brand-new repo via the minimal `CodeHost.createRepo` seam: the
// route constructs the `CodeHost` from the shared GitHub HTTP client + the standalone
// `resolveVcsToken` credential supplier (decomposition §5a/PR-2), authenticating with
// the org's GitHub App installation token when the App is installed, ELSE the
// org-default static `github_token` (a PAT with repo-create scope). Org-scoping is
// preserved: the token resolves against THIS org's App-installation/credentials.

import type pg from "pg";
import { type CreatedRepository, type CreateRepositoryInput } from "../../engine/contracts/codeHostTypes.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { resolveVcsToken } from "../../engine/credentials/vcsCredentials.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { buildProjectHostSeams } from "../../engine/providers/hostFactory.js";

export interface GreenfieldRepositoryCreateDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  input: CreateRepositoryInput;
}

export class GithubCredentialMissingError extends Error {
  constructor() {
    super("github credential missing");
    this.name = "GithubCredentialMissingError";
  }
}

export async function createGreenfieldRepository(deps: GreenfieldRepositoryCreateDeps): Promise<CreatedRepository> {
  const { pool, secrets, githubHttp, orgId, input } = deps;
  // Resolve the org's repo-creation credential the SAME way the rest of the system
  // does (resolveGithubToken): an App installation token when the org installed the
  // App, ELSE the org-default static `github_token` (a PAT with repo-create scope).
  // Repo creation is not App-only — requiring an installation here broke greenfield
  // for an org that connected a static PAT (the documented fallback path).
  const installation = await loadOrgGithubAppInstallation(pool, orgId);
  const staticRef = await loadOrgDefaultGithubCredentialRef(pool, orgId);
  // No App installation AND no org-default static credential ⇒ a real config gap,
  // surfaced LOUD (the operator must connect a GitHub credential). Explicit — not a
  // reliance on the resolver throwing — so the requirement is honest at this seam.
  if (installation === undefined && staticRef === undefined) {
    throw new GithubCredentialMissingError();
  }
  // The repo-create goes through the minimal `CodeHost.createRepo` seam (decomposition
  // PR-3): construct the `CodeHost` from the shared GitHub HTTP client + the standalone
  // `resolveVcsToken` credential supplier (decomposition §5a/PR-2). The token supplier
  // closes over the SAME credential context the system resolves from (installation-or-
  // static, with the 401 re-mint), so behavior is identical to the prior
  // credential-resolve + repo-create path — only the seam shape changed.
  // A credential-resolution failure HERE is therefore NOT "you didn't bind a credential"
  // (surfaced LOUD above) — it is infra/corruption (Vault outage, App mint failure, an
  // unparseable stored config); let it PROPAGATE (a 500), never mislabel it as
  // `github_credential_missing` (no_silent_fallbacks: a wrong, misleading user-facing
  // verdict is itself a silent degrade).
  const creds = {
    secrets,
    ...(installation !== undefined && { installation }),
    ...(staticRef !== undefined && { staticRef }),
    ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
  };
  const { codeHost } = buildProjectHostSeams(githubHttp, () => resolveVcsToken(githubHttp, creds));
  const created = await codeHost.createRepo(input);
  // Map the provider-neutral `CreatedHostRepo` back onto the greenfield
  // `CreatedRepository` shape (`fullName` = `owner/name`). The typed
  // `RepositoryAlreadyExistsError` (422) / `RepositoryCreationForbiddenError` (403)
  // propagate unchanged from `createRepo` (it reuses the same `createGitHubRepository`).
  return {
    fullName: `${created.repo.owner}/${created.repo.name}`,
    repoUrl: created.repoUrl,
    defaultBranch: created.defaultBranch,
  };
}
