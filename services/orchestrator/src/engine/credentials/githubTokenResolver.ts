// P3-0003: unified GitHub token resolution. Replaces the scattered
// `loadGithubToken(secrets, ref)` helpers that only knew how to read a static
// secret. The resolver chooses, in order:
//
//   1. App installation token — when the org's `organizations.config.github_app`
//      block is present, mint (or reuse a cached) auto-rotating installation
//      token via `GithubAppTokenMinter`. This is the preferred long-term model.
//   2. Static token fallback — read the secret at the configured/legacy ref
//      (`credential/github/...`). Keeps dev + Phase-2 back-compat working when
//      no App is installed.
//
// The returned object also carries a `refresh()` supplier so callers (notably
// `FetchGitHubHttpClient`) can re-mint once on a 401 without re-resolving the
// whole chain. For the static path, `refresh()` just re-reads the secret.

import type { SecretStore } from "../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";

export interface ResolvedGithubToken {
  token: string;
  source: "github_app" | "static";
  /** Re-mint/re-read the token; used for the 401-refresh retry path. */
  refresh(): Promise<string>;
}

export interface GithubTokenResolverInput {
  secrets: SecretStore;
  /** Org App installation block, when the org has installed the App. */
  installation?: OrgGithubAppInstallation;
  /** Static fallback ref (e.g. a project/brownfield `github_token` ref). */
  staticRef?: string;
  /** Shared minter (cache lives here); created per-call if omitted. */
  minter?: GithubAppTokenMinter;
}

const STATIC_DEFAULT_REF = "credential/github/default";

export async function resolveGithubToken(input: GithubTokenResolverInput): Promise<ResolvedGithubToken> {
  if (input.installation !== undefined) {
    const minter = input.minter ?? new GithubAppTokenMinter({ secrets: input.secrets });
    const request = {
      installationId: input.installation.installationId,
      credentialRef: input.installation.credentialRef,
    };
    const token = await minter.getInstallationToken(request);
    return {
      token,
      source: "github_app",
      refresh: () => minter.refreshInstallationToken(request),
    };
  }

  const ref = input.staticRef ?? process.env["TANREN_GITHUB_APP_TOKEN_REF"] ?? STATIC_DEFAULT_REF;
  const readStatic = async (): Promise<string> => {
    const secret = await input.secrets.get(ref);
    if (secret === undefined) {
      throw new Error(`missing GitHub credential ref: ${ref}`);
    }
    return secret.value;
  };
  return {
    token: await readStatic(),
    source: "static",
    refresh: readStatic,
  };
}
