// hostFactory (tanren-owns-the-engine.md §1, §6) — builds the per-project pair of
// purpose-shaped seams the engine routes through: a minimal `CodeHost` (code
// reads + ref push/fetch + the authorized land) and a hardened
// `SafeVisibilityProjection` (the best-effort forge-UI mirror that can NEVER block).
//
// CREDENTIAL REUSE (the §6 guardrail "do NOT invent new credential plumbing"): both
// seams resolve their access token through the SAME credential resolution the live
// GitHub path already uses — the caller passes the `resolveVcsToken` closure it builds
// from the standalone `credentials/vcsCredentials.ts:resolveVcsToken(http, creds)` (the
// standalone credential plumbing, §5a; one resolve per stage,
// installation-or-static, with the 401-refresh re-mint). This factory NEVER reads a
// secret itself; the seams stay token-free (a host swap can't leak GitHub credential
// shape into the engine) — the plaintext token travels only in each call's auth
// header. The factory just adapts the one `ResolvedVcsToken` supplier into the two
// shapes the seams want.

import { GitHubCodeHost, type CodeHostToken, type CodeHostTokenSupplier } from "./githubCodeHost.js";
import { GitHubVisibilityProjection } from "./githubVisibilityProjection.js";
import { harden, type SafeVisibilityProjection } from "../contracts/visibilityProjection.js";
import type { CodeHost } from "../contracts/codeHost.js";
import type { ResolvedVcsToken } from "../contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "./github.js";

/**
 * The credential supplier the host seams share: resolve the active access token for
 * a host call. This is EXACTLY `() => resolveVcsToken(http, creds)` — the standalone
 * live resolver (§5a) — so the factory reuses the existing plumbing rather than
 * re-deriving it.
 */
export type HostVcsTokenSupplier = () => Promise<ResolvedVcsToken>;

/** The pair of seams a project routes its code reads + forge-UI writes through. */
export interface ProjectHostSeams {
  /** Code reads (commit/diff/file/default-branch) + ref push/fetch + authorized land. */
  codeHost: CodeHost;
  /** The best-effort forge-UI mirror — every call yields a `ProjectionOutcome`, never throws. */
  visibility: SafeVisibilityProjection;
}

/** Adapt the shared `ResolvedVcsToken` supplier into the `CodeHost` token shape. */
function codeHostTokenSupplier(resolveVcsToken: HostVcsTokenSupplier): CodeHostTokenSupplier {
  return async (): Promise<CodeHostToken> => {
    const resolved = await resolveVcsToken();
    return {
      token: resolved.token,
      refresh: resolved.refresh,
      ...(resolved.authorizationIdentity !== undefined && { authorizationIdentity: resolved.authorizationIdentity }),
    };
  };
}

/**
 * Build the `CodeHost` + hardened `SafeVisibilityProjection` for a project from the
 * shared GitHub HTTP client + the project's existing token resolution. The
 * VisibilityProjection is `harden()`-ed at construction so the engine can only ever
 * hold the never-rejecting safe surface (a projection failure can never propagate to
 * the caller or alter a recorded decision — §0).
 */
export function buildProjectHostSeams(http: GitHubHttpClient, resolveVcsToken: HostVcsTokenSupplier): ProjectHostSeams {
  const codeHost = new GitHubCodeHost(http, codeHostTokenSupplier(resolveVcsToken));
  const visibility = harden(new GitHubVisibilityProjection(http, resolveVcsToken));
  return { codeHost, visibility };
}
