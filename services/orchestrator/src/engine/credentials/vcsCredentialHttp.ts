// Bridge a credential consumer's `VcsProvider` to the GitHub HTTP client the standalone
// credential helpers (`vcsCredentials.ts` — `resolveVcsToken`/`resolveVcsActorIdentity`)
// need. A credential consumer (the jj authed-push, the bot-push-identity resolver, the
// live-jj clone, the planner clone) is handed a `VcsProvider` purely for credential
// resolution; it narrows that to the GitHub client here, then calls the standalone helper
// directly — keeping token/identity resolution OFF the `VcsProvider` interface (§5a) while
// the not-yet-migrated forge-op callers keep their delegating methods.
//
// Lives in its OWN module (not `vcsCredentials.ts`) so the standalone helpers stay
// provider-import-free — `githubVcsProvider.ts` delegates INTO `vcsCredentials.ts`, so a
// `GitHubVcsProvider` import there would close a value-import cycle. Mirrors the merge
// path's `codeHostFor` narrowing exactly.

import { GitHubVcsProvider } from "../providers/githubVcsProvider.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";

/**
 * Resolve the shared GitHub HTTP client from a `VcsProvider` so a credential consumer can
 * call {@link import("./vcsCredentials.js").resolveVcsToken} directly. A non-GitHub
 * provider has no credential plumbing here yet — a LOUD throw, never a silent stand-in
 * (a future backend resolves its own credentials).
 */
export function vcsCredentialHttp(vcsProvider: VcsProvider): GitHubHttpClient {
  if (!(vcsProvider instanceof GitHubVcsProvider)) {
    throw new Error(
      `VCS credential resolution requires a GitHub provider; the configured VcsProvider (${vcsProvider.constructor.name}) cannot resolve credentials`,
    );
  }
  return vcsProvider.http;
}
