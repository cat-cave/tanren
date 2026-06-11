// MERGE-SAFETY (self-identity): resolve the GitHub identity Tanren PUSHES as for
// an on-runner authored-commit path, App-first / static-fallback, off the SAME
// `VcsProvider` seam the run-loop clone (`resolveCloneCredential` in
// plannerRunWorkspace.ts) and the merge stage's Tanren-identity set
// (`resolveTanrenLogins` in reviewMerge/mergeDispatch.ts) use.
//
// WHY this exists: a commit a runner authors that lands on a PR (the bootstrap
// commit — fixed in finding #6 — and the conflict-resolution commit — finding #7)
// must attribute to Tanren's REAL bot login. The external-change gate
// (reviewMerge/governancePosture.ts `assessExternalChange`) keys a commit whose
// author email does NOT map to a Tanren login as `<unknown>` → external → and a
// strict-posture run BLOCKS its own PR. Setting the bot's canonical
// `<bot-user-id>+<slug>[bot]@users.noreply.github.com` noreply email as the
// runner's git `user.email` makes GitHub map the commit back to `<slug>[bot]` —
// the login the gate recognizes as Tanren's.
//
// FAIL-CLOSED: an AUTHENTICATED path (an App installation OR a static credential
// ref is configured) MUST resolve a real identity — a resolution failure is a
// LOUD throw, never a degrade to an unattributable `*@tanren.invalid` author. The
// genuinely UNAUTHENTICATED public path (NEITHER configured) returns `undefined`:
// it never pushes as Tanren, so attribution is moot (the caller sets a
// non-attributable placeholder git still needs to commit at all).

import type { SecretStore } from "../contracts/secretStore.js";
import type { ActorIdentity, VcsProvider } from "../contracts/vcsProvider.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { GithubAppTokenMinter } from "./githubAppTokenMinter.js";

/** The App-first / static credential context a bot-identity resolution reads from. */
export interface BotPushIdentityContext {
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  installation?: OrgGithubAppInstallation;
  /** The static fallback credential ref (a project/org GitHub credential). */
  githubCredentialRef: string;
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * Resolve the bot {@link ActorIdentity} for an on-runner authored-commit path.
 *
 *   - AUTHENTICATED (an App installation OR a non-empty static ref): resolve the
 *     token App-first via `resolveToken`, then resolve its identity via
 *     `resolveActorIdentity` — the App bot's `<slug>[bot]` login + canonical
 *     noreply email (or the static PAT user's). A failure THROWS (loud).
 *   - UNAUTHENTICATED (NEITHER configured): return `undefined` (public path — the
 *     commit never pushes as Tanren; the caller uses a non-attributable placeholder).
 */
export async function resolveBotPushIdentity(ctx: BotPushIdentityContext): Promise<ActorIdentity | undefined> {
  const staticRef = ctx.githubCredentialRef.trim();
  if (ctx.installation === undefined && staticRef === "") {
    return undefined;
  }
  const resolved = await ctx.vcsProvider.resolveToken({
    secrets: ctx.secrets,
    ...(ctx.installation !== undefined && { installation: ctx.installation }),
    ...(staticRef !== "" && { staticRef }),
    ...(ctx.githubAppMinter !== undefined && { minter: ctx.githubAppMinter }),
  });
  // LOUD FAILURE: an authenticated path MUST attribute to a real login — a throw
  // here, never a degrade to an unattributable `*@tanren.invalid` author.
  return ctx.vcsProvider.resolveActorIdentity(resolved);
}
