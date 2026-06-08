// MERGE-SAFETY (self-identity): resolve the GitHub identity Tanren PUSHES as for a
// resolved credential — the single source of truth that keeps the run's git author
// + the merge stage's Tanren-identity set in lockstep (both derive from one
// credential, so Tanren's own commits attribute to a real login the external-change
// gate recognizes, never `<unknown>`). Extracted from githubVcsProvider.ts (per-file
// line cap); the provider's `resolveActorIdentity` composes these.
//
//   - static credential → `GET /user` → the PAT user's login + numeric id.
//   - App installation   → the App's bot login `<app-slug>[bot]` + bot id from
//                          `GET /app` (signed with the App JWT).
//
// The noreply email is the canonical `<id>+<login>@users.noreply.github.com` GitHub
// attributes commits by. Every failure is a LOUD throw — an authenticated push must
// attribute to a real login (no `.invalid`/`<unknown>` fallback).

import { loadGithubAppCredential } from "../credentials/githubApp.js";
import { signAppJwt } from "./githubAppTokenMinter.js";
import type { GitHubHttpClient } from "./github.js";
import type { ActorIdentity, ResolvedVcsToken, VcsCredentialContext } from "../contracts/vcsProvider.js";

/** The canonical GitHub noreply address that maps an email back to a login. */
function noreplyEmail(id: string, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/**
 * Invoke a resolved token's lazy identity supplier — the provider's
 * `resolveActorIdentity(token)`. Absent only on a token built outside the
 * provider's resolver (which never reaches the push path) → LOUD throw.
 */
export async function invokeTokenIdentity(token: ResolvedVcsToken): Promise<ActorIdentity> {
  if (token.identity === undefined) {
    throw new Error(
      "resolveActorIdentity: the resolved token carries no identity supplier (token not built by the provider's resolver)",
    );
  }
  return token.identity();
}

/**
 * Resolve the {@link ActorIdentity} for `token`, off the SAME `creds` that minted
 * it. Dispatches on the token source: a static credential reads `GET /user`; an App
 * installation token reads the App's bot identity via `GET /app`.
 */
export async function resolveGithubActorIdentity(
  http: GitHubHttpClient,
  token: ResolvedVcsToken,
  creds: VcsCredentialContext,
): Promise<ActorIdentity> {
  if (token.source === "github_app") {
    if (creds.installation === undefined) {
      throw new Error("resolveActorIdentity: github_app token has no installation context to resolve the bot identity");
    }
    return resolveAppBotIdentity(http, creds.installation.credentialRef, creds.secrets, token.token);
  }
  return resolveStaticUserIdentity(http, token);
}

/**
 * Static-credential identity: `GET /user` (through the provider's HTTP client, so
 * the timed/observability wrapper + the 401-refresh retry apply) → the PAT user's
 * login + numeric id → the canonical noreply email. A non-200 or a body missing
 * login/id throws LOUD (we never push as an unattributable identity).
 */
async function resolveStaticUserIdentity(http: GitHubHttpClient, token: ResolvedVcsToken): Promise<ActorIdentity> {
  const response = await http.request({
    method: "GET",
    path: "/user",
    token: token.token,
    refreshToken: token.refresh,
  });
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`GitHub token identity read (GET /user) failed: HTTP ${response.status}`);
  }
  const body = response.body as { login?: unknown; id?: unknown };
  if (typeof body.login !== "string" || body.login.trim() === "") {
    throw new TypeError("GitHub token identity read (GET /user) returned no login");
  }
  if (typeof body.id !== "number" && typeof body.id !== "string") {
    throw new TypeError("GitHub token identity read (GET /user) returned no id");
  }
  const login = body.login;
  const id = String(body.id);
  return { login, id, noreplyEmail: noreplyEmail(id, login) };
}

/**
 * App bot identity: `GET /app` (signed with a fresh App JWT) → the `<slug>[bot]`
 * login, then `GET /users/<slug>[bot]` → the BOT-USER id. GitHub attributes an
 * App's commits to a bot USER account whose login is `<slug>[bot]` and whose id is
 * the bot-user id — a DIFFERENT number than the App id (`GET /app`'s `id`). The
 * noreply MUST key off the bot-user id (`<bot-user-id>+<slug>[bot]@…`), or GitHub
 * won't attribute the commit to the bot and the PR-commit author stays `null`. The
 * login is the authoritative gate match; the bot-user id makes the noreply real.
 */
async function resolveAppBotIdentity(
  http: GitHubHttpClient,
  credentialRef: string,
  secrets: VcsCredentialContext["secrets"],
  installationToken: string,
): Promise<ActorIdentity> {
  const credential = await loadGithubAppCredential(secrets, credentialRef);
  const jwt = signAppJwt(credential.appId, credential.privateKeyPem, Math.floor(Date.now() / 1000));
  const appResponse = await http.request({ method: "GET", path: "/app", token: jwt });
  if (appResponse.status !== 200 || typeof appResponse.body !== "object" || appResponse.body === null) {
    throw new Error(`GitHub App identity read (GET /app) failed: HTTP ${appResponse.status}`);
  }
  const slug = (appResponse.body as { slug?: unknown }).slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new TypeError("GitHub App identity read (GET /app) returned no slug");
  }
  const login = `${slug}[bot]`;
  // Resolve the BOT-USER id (NOT the App id) so the noreply attributes commits to
  // the bot account. `GET /users/<slug>[bot]` is a public read — auth it with the
  // INSTALLATION token (the App JWT is only valid for `/app*` endpoints and 401s here).
  const userResponse = await http.request({
    method: "GET",
    path: `/users/${encodeURIComponent(login)}`,
    token: installationToken,
  });
  if (userResponse.status !== 200 || typeof userResponse.body !== "object" || userResponse.body === null) {
    throw new Error(`GitHub App bot-user identity read (GET /users/${login}) failed: HTTP ${userResponse.status}`);
  }
  const botId = (userResponse.body as { id?: unknown }).id;
  if (typeof botId !== "number" && typeof botId !== "string") {
    throw new TypeError(`GitHub App bot-user identity read (GET /users/${login}) returned no id`);
  }
  const id = String(botId);
  return { login, id, noreplyEmail: noreplyEmail(id, login) };
}
