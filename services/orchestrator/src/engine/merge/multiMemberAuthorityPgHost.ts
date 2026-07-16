// Production CodeHost construction for MQ-2. Credential resolution stays on the
// existing provider path; this module creates no alternate secret or host authority.

import { installationFromOrgConfig } from "../config/orgConfig.js";
import type { CodeHost } from "../contracts/codeHost.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { GitHubCodeHost, parseGitHubRepository } from "../providers/githubCodeHost.js";
import { MainHeadCache } from "../providers/mainHeadCache.js";
import { resolveGithubStaticRef } from "./batchChecker.js";
import type { ProjectAuthorityRow } from "./multiMemberAuthorityPgState.js";

export interface MultiMemberAuthorityHostDeps {
  readonly githubHttp: GitHubHttpClient;
  readonly secrets: SecretStore;
  readonly githubAppMinter?: GithubAppTokenMinter;
}

export async function buildMultiMemberCodeHost(
  deps: MultiMemberAuthorityHostDeps,
  project: ProjectAuthorityRow,
): Promise<{ readonly host: CodeHost; readonly repo: { readonly owner: string; readonly name: string } }> {
  const installation = installationFromOrgConfig(project.org_config);
  const staticRef = resolveGithubStaticRef(project.project_config, project.org_config);
  const token = await resolveVcsToken(deps.githubHttp, {
    secrets: deps.secrets,
    ...(installation !== undefined && { installation }),
    ...(staticRef !== undefined && { staticRef }),
    ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
  });
  const host = new GitHubCodeHost(
    deps.githubHttp,
    async () => ({ token: token.token, ...(token.refresh !== undefined && { refresh: token.refresh }) }),
    // A fresh cache ensures the revalidator's sole main read is not a stale process hit.
    new MainHeadCache(),
  );
  return { host, repo: parseGitHubRepository(project.repo_url) };
}
