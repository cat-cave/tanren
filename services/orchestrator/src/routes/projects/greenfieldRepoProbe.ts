// GREENFIELD RE-ATTACH GUARD (apex v84) — the greenfield repo-EMPTINESS probe
// companion to `greenfieldRepoCreate.ts` / `greenfieldRepoDelete.ts`. Before the
// derive RE-ATTACHES to a repo that already exists (a `RepositoryAlreadyExistsError`
// on create + no bound project), it must know whether the repo is the stranded,
// empty auto_init seed the re-attach idempotency intends — or a repo already full of
// a PRIOR run's `tanren compose:` history (which would cause a cross-run base
// divergence if silently reused). This wires that probe against `CodeHost
// .isRepoBareAutoInit`, closing over the SAME GitHub HTTP client + `resolveVcsToken`
// credential supplier the create/delete paths use. The token resolves against the
// same org credentials (App installation or static PAT); a missing credential is
// loud (`GithubCredentialMissingError`, exactly like the create).

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

export interface GreenfieldRepositoryProbeDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  target: { owner: string; name: string };
}

/**
 * Probe whether the greenfield target repo is at the bare `auto_init` state (safe to
 * re-attach) vs already carrying content/history (a prior run's compose commits). Via
 * the `CodeHost.isRepoBareAutoInit` seam. The credential resolution mirrors
 * `createGreenfieldRepository`/`deleteGreenfieldRepository` so the create-then-probe
 * uses the exact same credential context. The resolved token travels only in the
 * request auth header (never in a thrown message).
 */
export async function probeGreenfieldRepositoryBareAutoInit(deps: GreenfieldRepositoryProbeDeps): Promise<boolean> {
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
  return codeHost.isRepoBareAutoInit(target);
}
