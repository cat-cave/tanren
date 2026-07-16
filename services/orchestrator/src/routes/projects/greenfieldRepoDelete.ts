// DERIVE TRANSACTIONAL ROLLBACK — the greenfield repo-DELETE companion to
// `greenfieldRepoCreate.ts` (task #78). The derive registers a compensation
// for each repo it creates; this is the route-layer wiring that closes over the
// shared GitHub HTTP client + the standalone `resolveVcsToken` credential
// supplier, exactly the same shape the create path uses. The token resolves
// against the same org credentials (App installation or static PAT); a
// credential failure here is loud (a missing credential surfaces as
// `GithubCredentialMissingError`, exactly like the create).
//
// NEVER call this from a regular run path — repo deletion is irreversible and
// exists ONLY to compensate a partially-failed derive.

import type pg from "pg";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { resolveVcsToken } from "../../engine/credentials/vcsCredentials.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { buildProjectHostSeams } from "../../engine/providers/hostFactory.js";
import { GithubCredentialMissingError } from "./greenfieldRepoCreate.js";

export interface GreenfieldRepositoryDeleteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  target: { owner: string; name: string };
}

/**
 * Delete a greenfield-created repo on GitHub via the `CodeHost.deleteRepo` seam.
 * IDEMPOTENT — a 404 (already gone) is a successful no-op (the contract). The
 * resolved token travels only in the request auth header (never in a thrown
 * message). The credential resolution mirrors `createGreenfieldRepository` so
 * the create-then-rollback round-trip uses the exact same credential context.
 */
export async function deleteGreenfieldRepository(deps: GreenfieldRepositoryDeleteDeps): Promise<void> {
  const { pool, secrets, githubHttp, orgId, target } = deps;
  const installation = await loadOrgGithubAppInstallation(pool, orgId);
  const staticRef = await loadOrgDefaultGithubCredentialRef(pool, orgId);
  if (installation === undefined && staticRef === undefined) {
    throw new GithubCredentialMissingError();
  }
  const creds = {
    secrets,
    orgId,
    ...(installation !== undefined && { installation }),
    ...(staticRef !== undefined && { staticRef }),
    ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
  };
  const { codeHost } = buildProjectHostSeams(githubHttp, () => resolveVcsToken(githubHttp, creds));
  await codeHost.deleteRepo(target);
}
