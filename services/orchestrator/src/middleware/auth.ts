import { runWithJobOrgId } from "@tanren/db";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { ActorContext } from "../auth/schemas.js";
import type { IdentityStore } from "../auth/identityStore.js";

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

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthMiddlewareOptions {
  store: IdentityStore;
  platformAdminUserIds?: ReadonlySet<string>;
  /** When true, expose an unauthenticated escape hatch wiring a fixed actor context (LocalDev). */
  localDevActor?: ActorContext | undefined;
  /** Paths that bypass authentication; defaults cover health, version, auth handshake. */
  publicPaths?: ReadonlySet<string>;
}

export interface ActorContextEnv {
  Variables: {
    actor?: ActorContext;
    // RLS wave R1: the request's org session-context root, derived from the
    // resolved ActorContext. `null` for a legacy/unscoped actor (no org). The
    // org-scoped DB path (`runWithOrgScope`) keys off this so the per-request
    // `SET LOCAL app.current_org_id` always matches the authenticated actor.
    requestOrgId?: string | null;
  };
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<ActorContextEnv> {
  const publicPaths = options.publicPaths ?? PUBLIC_PATHS;
  return async (c, next) => {
    if (publicPaths.has(c.req.path)) {
      return next();
    }

    const bearer = extractBearer(c);
    if (bearer !== undefined) {
      const record = await options.store.findApiTokenByRaw(bearer);
      if (record === undefined) {
        return c.json({ error: "unauthorized", message: "invalid api token" }, 401);
      }
      const actor = await options.store.resolveActorContext({
        userId: record.userId,
        orgId: extractOrgId(c),
        projectId: extractProjectId(c),
        source: "api_token",
        platformAdminUserIds: options.platformAdminUserIds,
      });
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
        const actor = await options.store.resolveActorContext({
          userId: session.userId,
          orgId: extractOrgId(c),
          projectId: extractProjectId(c),
          source: "session",
          platformAdminUserIds: options.platformAdminUserIds,
        });
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
 * the actor has no org (legacy/unscoped). Handlers adopting the org-scoped DB
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
