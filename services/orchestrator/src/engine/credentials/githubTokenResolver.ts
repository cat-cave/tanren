// P3-0003: unified GitHub token resolution. Replaces the scattered
// `loadGithubToken(secrets, ref)` helpers that only knew how to read a static
// secret. The resolver chooses, in order:
//
//   1. App installation token — when the org's `organizations.config.github_app`
//      block is present, mint (or reuse a cached) auto-rotating installation
//      token via `GithubAppTokenMinter`. This is the preferred long-term model.
//   2. Static token — read the secret at the configured ref. The ref comes from
//      the caller's `staticRef` (the run's resolved project/org GitHub
//      credential) or `TANREN_GITHUB_APP_TOKEN_REF`. There is NO hardcoded
//      default ref: when no App is installed and neither source supplies a ref,
//      that is a hard configuration error, not a silent default.
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

/**
 * Thrown when the static path has no credential ref to read: no App
 * installation, no caller `staticRef`, and no `TANREN_GITHUB_APP_TOKEN_REF`.
 * Per the no-fallback directive there is no hardcoded default ref — this is a
 * configuration error the operator must fix (link a project/org GitHub
 * credential, install the App, or set the env ref).
 */
export class NoGithubCredentialConfiguredError extends Error {
  constructor() {
    super(
      "No GitHub credential configured for this run: no App installation, no resolved project/org credential ref, and TANREN_GITHUB_APP_TOKEN_REF is unset",
    );
    this.name = "NoGithubCredentialConfiguredError";
  }
}

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

  const ref = input.staticRef ?? process.env["TANREN_GITHUB_APP_TOKEN_REF"];
  if (ref === undefined || ref.trim() === "") {
    throw new NoGithubCredentialConfiguredError();
  }
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
