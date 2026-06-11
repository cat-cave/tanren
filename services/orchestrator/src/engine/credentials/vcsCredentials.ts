// Standalone VCS credential plumbing — the token + actor-identity resolution every
// host seam needs (decomposition §5a). These are NOT forge ops; they are the credential
// resolution `hostFactory`'s token supplier, the jj authed-push, the bot-push-identity
// resolver, the live jj clone, and the planner clone all need. Keeping them here (not on
// `CodeHost`) keeps the host seam token-free — a host swap can't re-leak GitHub
// credential shape into the engine seam (the `hostFactory.ts` doctrine).
//
// THE SOLE credential resolver (the deleted `VcsProvider` interface delegated here
// before PR-9 retired it): `resolveGithubToken` (App-first, static fallback, hard-throw
// when neither is configured) wrapped into a `ResolvedVcsToken` whose lazy `identity`
// supplier closes over the SAME `creds` that minted the token — so the run's git author
// and the merge stage's Tanren-identity set can never disagree (MERGE-SAFETY). A stage
// resolves once (`resolveVcsToken(http, creds)`) and threads the token into many ops.

import { resolveGithubToken } from "./githubTokenResolver.js";
import { invokeTokenIdentity, resolveGithubActorIdentity } from "../providers/githubActorIdentity.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { ActorIdentity, ResolvedVcsToken, VcsCredentialContext } from "../contracts/codeHostTypes.js";

/**
 * Resolve a usable access token (+ refresh supplier) for the repo from the credential
 * context: App-first, static fallback, hard-throw when neither is configured. The
 * returned token carries a lazy `identity` supplier that resolves the {@link ActorIdentity}
 * off the SAME `creds` (App context in scope) — `resolveVcsActorIdentity(token)` invokes it.
 *
 * `http` is the shared (timed) GitHub HTTP client the identity read goes through (so the
 * 401-refresh retry + observability wrapper apply). The token plaintext travels only in
 * each call's auth header / the lazy identity read; this never stores or logs it.
 */
export async function resolveVcsToken(http: GitHubHttpClient, creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
  const resolved = await resolveGithubToken({
    secrets: creds.secrets,
    installation: creds.installation,
    staticRef: creds.staticRef,
    minter: creds.minter,
  });
  const token: ResolvedVcsToken = {
    token: resolved.token,
    source: resolved.source,
    refresh: resolved.refresh,
    // MERGE-SAFETY: the lazy identity supplier closes over the SAME creds that resolved
    // the token (run git author + merge identity set can't disagree).
    identity: () => resolveGithubActorIdentity(http, token, creds),
  };
  return token;
}

/**
 * MERGE-SAFETY (self-identity): resolve the {@link ActorIdentity} for an already-resolved
 * token by invoking its lazy supplier (populated by {@link resolveVcsToken} at resolve
 * time, with the App context in scope). A failure is a LOUD throw (no `.invalid` /
 * `<unknown>` fallback) — an authenticated push must attribute to a real login.
 */
export async function resolveVcsActorIdentity(token: ResolvedVcsToken): Promise<ActorIdentity> {
  return invokeTokenIdentity(token);
}
