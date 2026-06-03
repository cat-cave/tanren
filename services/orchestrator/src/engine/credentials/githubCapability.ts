// Connect-GitHub capability probe (Wave-2 operator API). Answers, against the
// org's REAL resolved GitHub credential, the one question an operator needs
// BEFORE a greenfield run: "can this identity CREATE repos?" — so the
// `administration:write` (App) / `repo`-scope (PAT) gap is learned up front
// instead of as a late 403 from `VcsProvider.createRepository`.
//
// This is a REAL check against the credential, never a guess:
//   - App installation → sign the App JWT (the SAME signer the minter uses) and
//     read `GET /app/installations/{id}` → its `permissions.administration` and
//     `account.login`. `administration: "write"` ⇒ can create repos.
//   - Static token (PAT) → `GET /user` and read the `X-OAuth-Scopes` RESPONSE
//     header (the authoritative list of scopes the token actually carries) plus
//     the `login`. The classic `repo` scope authorizes repo creation; a token
//     missing it (or a fine-grained token that exposes no classic scope header)
//     reports the gap. The secret is sent only in the Authorization header and
//     is never logged or returned.
//
// The probe is HTTP-injectable (`fetchImpl`) so route tests exercise the real
// header/permission parsing without a live GitHub.

import { loadGithubAppCredential } from "./githubApp.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import { signAppJwt } from "../providers/githubAppTokenMinter.js";

/** The capability view the GET route renders (never carries a secret). */
export interface GithubCapability {
  /** The connected GitHub identity's login (the App account / the PAT user). */
  login: string | null;
  /** True only when a REAL check confirms repo-creation authority. */
  canCreateRepos: boolean;
  /** The permission(s)/scope(s) needed for repo creation that are NOT granted. */
  missingPermissions: string[];
}

export interface GithubAppCapabilityInput {
  secrets: SecretStore;
  installation: OrgGithubAppInstallation;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** Injectable clock (ms epoch) so the App JWT `iat`/`exp` are deterministic. */
  now?: () => number;
}

export interface GithubTokenCapabilityInput {
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

/** The classic OAuth scope that authorizes creating repositories. */
const REPO_SCOPE = "repo";
/** The GitHub App permission (at `write`) that authorizes creating repositories. */
const ADMINISTRATION_WRITE = "administration:write";

function normalizeBaseUrl(apiBaseUrl: string | undefined): string {
  return (apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
}

/**
 * Probe an org's GitHub App installation for repo-creation authority. Signs the
 * App JWT and reads the installation's granted permissions + account login. A
 * non-2xx from GitHub is a LOUD failure (the caller maps it to a 502) rather
 * than a silent "cannot" — we never guess the capability.
 */
export async function probeGithubAppCapability(input: GithubAppCapabilityInput): Promise<GithubCapability> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(input.apiBaseUrl);
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  const credential = await loadGithubAppCredential(input.secrets, input.installation.credentialRef);
  const jwt = signAppJwt(credential.appId, credential.privateKeyPem, nowSeconds);

  const response = await fetchImpl(
    `${baseUrl}/app/installations/${encodeURIComponent(input.installation.installationId)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub App installation read failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => {})) as
    | { account?: { login?: unknown }; permissions?: Record<string, unknown> }
    | undefined;
  const login = typeof body?.account?.login === "string" ? body.account.login : null;
  const administration = body?.permissions?.["administration"];
  const canCreateRepos = administration === "write";
  return {
    login,
    canCreateRepos,
    missingPermissions: canCreateRepos ? [] : [ADMINISTRATION_WRITE],
  };
}

/**
 * Probe a static GitHub token (PAT) for repo-creation authority. Reads the
 * authoritative `X-OAuth-Scopes` response header from `GET /user` — the actual
 * scopes the token carries — plus the authenticated `login`. The token travels
 * only in the Authorization header. A non-2xx is a LOUD failure.
 */
export async function probeGithubTokenCapability(input: GithubTokenCapabilityInput): Promise<GithubCapability> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(input.apiBaseUrl);
  const response = await fetchImpl(`${baseUrl}/user`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub token identity read failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => {})) as { login?: unknown } | undefined;
  const login = typeof body?.login === "string" ? body.login : null;
  const scopes = parseOAuthScopes(response.headers.get("x-oauth-scopes"));
  const canCreateRepos = scopes.includes(REPO_SCOPE);
  return {
    login,
    canCreateRepos,
    missingPermissions: canCreateRepos ? [] : [REPO_SCOPE],
  };
}

/**
 * Parse the comma-separated `X-OAuth-Scopes` header into a scope list. A
 * fine-grained PAT (or an empty/absent header) yields `[]` — repo-creation is
 * then reported as NOT confirmed (the classic `repo` scope is absent), so the
 * operator is told to use a `repo`-scoped token.
 */
export function parseOAuthScopes(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}
