# Operator authentication and authorization

Phase 2A introduces a multi-user authentication and authorization substrate for the Tanren orchestrator, the dashboard, and the CLI. This page is the operator's reference for how identity, sessions, and API tokens are managed in v0.

## Identity model

Tanren models identity in five tables (see `db/src/schema.ts`):

- `organizations` — the top-level tenant. v0 supports one `kind`, `github_org`. The `external_id` is the GitHub org id; the `login` is the GitHub org login lowercased.
- `users` — one row per real human, keyed by `(provider, provider_subject)`. v0 providers: `github_oauth`, `oidc` (interface stub, not wired), `local_dev` (tests only).
- `org_members` — `(org_id, user_id, role)`. Role is `admin` or `member`. The first user to sign in to a given org becomes `admin`; subsequent users are added as `member`.
- `project_members` — `(project_id, user_id, role)`. Project-level membership lets you scope below the org granularity.
- `sessions` — server-side session records keyed by an HTTP-only cookie. Each session carries a CSRF token.
- `api_tokens` — long-lived tokens used by the CLI. Only the SHA-256 hash is persisted; the raw token is shown once at creation.

## Identity provider interface

The orchestrator exposes a single `IdentityProvider` interface (`services/orchestrator/src/auth/identityProvider.ts`):

```ts
interface IdentityProvider {
  readonly id: "github_oauth" | "oidc" | "local_dev";
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<IdentityClaims>;
}
```

v0 ships three implementations:

- `GitHubOAuthProvider` — the production identity provider. Calls `https://github.com/login/oauth/access_token`, then `/user`, `/user/emails`, and `/user/orgs` on `api.github.com` to assemble identity claims. Org claims become `organizations` rows; user claims become a `users` row.
- `OidcProvider` — stub. Wires through `IdentityProvider.id === "oidc"` and exists so the interface is exercised. The production OIDC provider (Authentik first) is not wired in v0.
- `LocalDevProvider` — returns a fixed identity. Used in tests and explicit dev mode only. Never enabled by default.

## Browser flow

1. Operator visits the dashboard.
2. With `TANREN_REQUIRE_AUTH=1` set, the dashboard redirects to `/auth/login`, which 302s to the orchestrator's `/auth/login?provider=github_oauth`.
3. The orchestrator generates a random `state`, stores it in a short-lived cookie, and 302s to GitHub.
4. GitHub returns to `/auth/callback?provider=github_oauth&code=...&state=...`.
5. The orchestrator validates the state, exchanges the code, upserts the user and any orgs the user belongs to, creates a server-side session, and sets the `tanren_session` HTTP-only cookie. The JSON response includes the `csrfToken` the dashboard needs for state-changing calls.

## CSRF protection

Every state-changing route (`POST`/`PUT`/`PATCH`/`DELETE`) requires an `X-CSRF-Token` header equal to the session's CSRF token. The dashboard reads it from `/auth/me` after sign-in. Requests with a session cookie but no matching CSRF header are rejected with a `403 csrf_token_invalid`.

## CLI flow

```sh
tanren auth login
```

If invoked without `--token`, the CLI calls `/auth/cli/start`, prints the authorization URL, and asks the operator to complete the flow in their browser. After the browser flow finishes and the operator is signed in, they call `POST /auth/cli/complete` from the dashboard (in v0, via a small "create CLI token" button surfaced by P2B work), copy the returned token, and run:

```sh
tanren auth login --token tnt_xxxx
```

The CLI writes the token to `~/.config/tanren/auth.json` with `0600` permissions. Subsequent CLI calls add `Authorization: Bearer <token>` automatically. Other commands:

- `tanren auth status` — print metadata (never the raw token).
- `tanren auth logout` — remove the stored token.

## Actor context

Every orchestrator route resolves an `ActorContext` from the session or API token. The shape:

```ts
interface ActorContext {
  userId: string;
  orgId: string | null;
  projectId: string | null;
  scopes: ActorScope[];
  source: "session" | "api_token" | "local_dev";
}
```

The middleware extracts `orgId`/`projectId` from the request path (`/orgs/:orgId/...`, `/projects/:projectId/...`), the `x-tanren-org-id`/`x-tanren-project-id` headers, or the matching query params. Scopes are derived from membership tables — `org:admin`/`org:member`/`project:admin`/`project:member` — plus an out-of-band `platform:admin` set for operators configured by id.

Repository functions accept the actor context as an optional argument and apply org/project membership filtering. The Phase 2A entry point is `createProject`, `createSpec`, and `createQueuedRunFromSpec`; subsequent Phase 2A specs widen the surface.

## Configuration

In dev, the orchestrator reads GitHub OAuth credentials from env:

- `TANREN_GITHUB_OAUTH_CLIENT_ID`
- `TANREN_GITHUB_OAUTH_CLIENT_SECRET`
- `TANREN_PUBLIC_BASE_URL` — the absolute URL the orchestrator is reachable at, used to compute the OAuth redirect URI.
- `TANREN_COOKIE_SECURE=1` — set in prod to mark cookies `Secure`.

In prod, P2A-0004 lands the dev/prod compose split. The prod profile reads OAuth client id/secret from Vault under `org/github/oauth/<orgId>`; the env-var fallback is documented as a dev-only convenience.

## What is not in Phase 2A

- The OIDC production provider (Authentik) — interface only, blocked behind a "not wired" error.
- A dashboard sign-in UI — the dashboard relies on a redirect to the orchestrator's `/auth/login` endpoint. The hi-fi sign-in screen ships in Phase 2B.
- Per-org GitHub App installation — only OAuth in v0.
- Token rotation, key rotation, audit-log surface for raw-token access — P2A-0009 and later operate on the same access-scope vocabulary.
