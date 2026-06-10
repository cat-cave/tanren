import { runWithJobOrgId } from "@tanren/db";
import type { Context, MiddlewareHandler, Next } from "hono";
import type pg from "pg";
import type { ActorContext } from "../auth/schemas.js";
import type { IdentityStore } from "../auth/identityStore.js";
import { resolveRequestOrgFromResource } from "./requestOrgResolver.js";

export const SESSION_COOKIE = "tanren_session";
export const CSRF_HEADER = "x-csrf-token";

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/version",
  "/doctor",
  "/auth/login",
  "/auth/callback",
  "/auth/providers",
  "/auth/cli/start",
  "/auth/cli/complete",
]);

// M2: the GitHub webhook RECEIVERS carry no session/bearer — an inbound webhook
// authenticates by its mandatory HMAC signature (M1; `routes/githubWebhooks/*`),
// not the session. They are mounted at root (`/github/webhooks/ci`,
// `/github/webhooks/issues/:sourceId`), so an EXACT-match public-path set cannot
// cover the parameterized issues path; we exempt the whole receiver PREFIX so the
// HMAC verifier — not a session 401 — is the gate. ONLY this prefix is exempted;
// every other route still requires a session/bearer. The receivers themselves
// reject any request lacking a valid signature 401, so this is not an open door.
const PUBLIC_PATH_PREFIXES = ["/github/webhooks/"] as const;

function isPublicPath(publicPaths: ReadonlySet<string>, path: string): boolean {
  if (publicPaths.has(path)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthMiddlewareOptions {
  store: IdentityStore;
  platformAdminUserIds?: ReadonlySet<string>;
  /** When true, expose an unauthenticated escape hatch wiring a fixed actor context (LocalDev). */
  localDevActor?: ActorContext | undefined;
  /** Paths that bypass authentication; defaults cover health, version, auth handshake. */
  publicPaths?: ReadonlySet<string>;
  // RLS HTTP-route scoping: the pool used to resolve the request's org from the
  // addressed RESOURCE id (specs/runs/projects in the path) when there is no
  // `orgs` path segment — the resource-keyed root shapes (`/specs/:specId/runs`,
  // `/runs/:runId/*`). Looked up on the BYPASSRLS system pool inside the
  // resolver. When omitted (pure-auth unit tests), only the path-`orgs` /
  // header / query / single-org arms apply; the resource arm is skipped.
  pool?: pg.Pool;
}

export interface ActorContextEnv {
  Variables: {
    actor?: ActorContext;
    // RLS wave R1: the request's org session-context root, derived from the
    // resolved ActorContext. `null` for a system / null-org actor (no org). The
    // org-scoped DB path (`runWithOrgScope`) keys off this so the per-request
    // `SET LOCAL app.current_org_id` always matches the authenticated actor.
    requestOrgId?: string | null;
  };
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<ActorContextEnv> {
  const publicPaths = options.publicPaths ?? PUBLIC_PATHS;
  return async (c, next) => {
    if (isPublicPath(publicPaths, c.req.path)) {
      return next();
    }

    const bearer = extractBearer(c);
    if (bearer !== undefined) {
      const record = await options.store.findApiTokenByRaw(bearer);
      if (record === undefined) {
        return c.json({ error: "unauthorized", message: "invalid api token" }, 401);
      }
      const actor = await resolveActorForRequest(c, options, record.userId, "api_token");
      bindActor(c, actor);
      return runScoped(c, next);
    }

    const cookie = readCookie(c, SESSION_COOKIE);
    if (cookie !== undefined) {
      const session = await options.store.loadSession(cookie);
      if (session !== undefined) {
        if (STATE_CHANGING_METHODS.has(c.req.method)) {
          const csrf = c.req.header(CSRF_HEADER);
          if (csrf !== session.csrfToken) {
            return c.json({ error: "csrf_token_invalid" }, 403);
          }
        }
        const actor = await resolveActorForRequest(c, options, session.userId, "session");
        bindActor(c, actor);
        return runScoped(c, next);
      }
    }

    if (options.localDevActor !== undefined) {
      bindActor(c, options.localDevActor);
      return runScoped(c, next);
    }

    return c.json({ error: "unauthorized", message: "authentication required" }, 401);
  };
}

// RLS HTTP-route scoping: resolve the actor AND the org the request is scoped to
// — the systematic middleware-level org resolution that covers EVERY route shape,
// not just `/orgs/:orgId/*`. The org is resolved in this precedence (#181's
// strategy, extended with the resource + single-org arms):
//
//   1. PATH `:orgId` / header / query — the explicitly addressed org (extractOrgId);
//   2. else the addressed RESOURCE → its org — look up `specs.org_id` /
//      `runs.org_id` / `projects.org_id` keyed by the id in the path, via a
//      `runWithSystemScope` lookup (the resource-keyed root shapes:
//      `/specs/:specId/runs`, `/runs/:runId/*`);
//   3. else the actor's SOLE org — an unambiguous default when the user belongs
//      to exactly one org (so a body-only root POST like `/projects` still scopes).
//
// Every candidate org is passed to `resolveActorContext`, which re-checks the
// user's membership — so the resolution NEVER widens access: a non-member (or an
// unknown/missing resource) resolves back to NO org, and the handler then 404s
// under its own scope exactly as before. The result drives both the actor's
// `orgId` (so self-scoping creators like `createQueuedRunFromSpec` open the right
// `runWithOrgScope`) and the per-request `runWithJobOrgId` scope (so every
// handler `.query` on the scoping pool self-scopes).
async function resolveActorForRequest(
  c: Context<ActorContextEnv>,
  options: AuthMiddlewareOptions,
  userId: string,
  source: ActorContext["source"],
): Promise<ActorContext> {
  let orgId = extractOrgId(c);
  // Arm 2: no explicitly addressed org → derive it from the addressed resource.
  if (orgId === undefined && options.pool !== undefined) {
    orgId = await resolveRequestOrgFromResource(options.pool, c.req.path);
  }
  const actor = await options.store.resolveActorContext({
    userId,
    orgId,
    projectId: extractProjectId(c),
    source,
    platformAdminUserIds: options.platformAdminUserIds,
  });
  // Arm 3: the request addressed no org and none was resolved from a resource,
  // and the actor carries none — resolve the user's SOLE org when there is exactly
  // one (re-resolving so the membership scopes are derived too). A user in zero OR
  // multiple orgs gets no implicit scope (the bootstrap routes that list-my-orgs
  // are correctly system-scoped and need none).
  //
  // No-silent-fallbacks doctrine — this is a DELIBERATE single-org UX affordance,
  // NOT a swallowed scope failure, and it is fail-closed by construction:
  //   • it fires ONLY when the request is genuinely org-AMBIGUITY-FREE (a body-only
  //     root POST like `/projects` from a user who belongs to exactly one org), so
  //     there is no required-but-denied org being masked — there is simply no other
  //     org the request could mean;
  //   • the AMBIGUOUS case (a multi-org user) resolves to `undefined`
  //     (`resolveSoleOrgForUser` returns the org only on `rowCount === 1`), so it
  //     NEVER silently picks one of several orgs — that would be the violation;
  //   • it cannot widen access: the chosen org is re-run through
  //     `resolveActorContext`, which re-checks membership, so a non-member never
  //     gains scope.
  if (orgId === undefined && actor.orgId === null) {
    const soleOrgId = await options.store.resolveSoleOrgForUser(userId);
    if (soleOrgId !== undefined) {
      return options.store.resolveActorContext({
        userId,
        orgId: soleOrgId,
        projectId: extractProjectId(c),
        source,
        platformAdminUserIds: options.platformAdminUserIds,
      });
    }
  }
  return actor;
}

// RLS wave R1: bind the resolved actor AND its org session-context root onto
// the request. Every authenticated path funnels through here so the org the
// org-scoped DB client stamps (`SET LOCAL app.current_org_id`) is always the
// actor's org — never a route param the handler could get wrong.
function bindActor(c: Context<ActorContextEnv>, actor: ActorContext): void {
  c.set("actor", actor);
  c.set("requestOrgId", actor.orgId);
}

// RLS R3b: establish the request's per-org scope around the downstream handler.
// The resolved actor's org (set on the context by `bindActor`) is published on
// the lightweight `runWithJobOrgId` ambient store — which holds ONLY the org id,
// no checked-out connection — so it is safe to keep open across the whole request
// (including any external I/O a handler does). Operator/control-plane route
// handlers run their tenant-table queries on an `orgScopingPool`, whose `.query`
// opens a SHORT `runWithOrgScope` per statement from this ambient org id, so the
// runtime `tanren_app` role's reads/writes carry `app.current_org_id` and the
// deny-by-default RLS policies admit them. When the actor has NO org (a
// bootstrap/unscoped request — e.g. `GET /orgs`, which lists the user's orgs via
// `runWithSystemScope` itself), no scope is set and the handler runs as before.
function runScoped(c: Context<ActorContextEnv>, next: Next): Promise<void> {
  const orgId = c.get("requestOrgId");
  if (orgId === undefined || orgId === null) {
    return Promise.resolve(next());
  }
  return runWithJobOrgId(orgId, () => Promise.resolve(next()));
}

/**
 * The authenticated request's org (the session-context root), or `null` when
 * the actor has no org (a system / null-org actor). Handlers adopting the org-scoped DB
 * path read this rather than re-deriving the org from a route param.
 */
export function getRequestOrgId(c: Context<ActorContextEnv>): string | null {
  return c.get("requestOrgId") ?? null;
}

function extractBearer(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1];
}

export function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie");
  if (header === undefined) {
    return undefined;
  }
  for (const piece of header.split(/;\s*/u)) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    if (piece.slice(0, eq) === name) {
      return decodeURIComponent(piece.slice(eq + 1));
    }
  }
  return undefined;
}

export function setSessionCookie(value: string, options: { secure?: boolean; maxAgeSeconds?: number } = {}): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.secure === true) {
    parts.push("Secure");
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}

// The auth middleware runs as a top-level `app.use("*", …)`, BEFORE the matched
// `/orgs/:orgId/*` sub-route resolves — so `c.req.param("orgId")` is NOT yet
// populated here (Hono fills route params only in the matched handler's chain).
// The dashboard BFF forwards only the session cookie (no `x-tanren-org-id`
// header), so without parsing the path the actor would resolve with NO org →
// `actorCanAccessOrg` would 403 every `/orgs/:orgId/*` request. We therefore
// derive the addressed org/project from the request PATH as the fallback, so the
// actor's org scope (and the per-request `runWithJobOrgId` RLS scope) is always
// the org being addressed. Header/query still win when explicitly supplied.
function pathSegmentAfter(path: string, marker: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const index = segments.indexOf(marker);
  if (index === -1 || index + 1 >= segments.length) {
    return undefined;
  }
  return decodeURIComponent(segments[index + 1]!);
}

function extractOrgId(c: Context): string | undefined {
  return (
    c.req.header("x-tanren-org-id") ??
    c.req.query("orgId") ??
    c.req.param("orgId") ??
    pathSegmentAfter(c.req.path, "orgs")
  );
}

function extractProjectId(c: Context): string | undefined {
  return (
    c.req.header("x-tanren-project-id") ??
    c.req.query("projectId") ??
    c.req.param("projectId") ??
    pathSegmentAfter(c.req.path, "projects")
  );
}
