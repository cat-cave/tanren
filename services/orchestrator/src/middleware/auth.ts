import type { Context, MiddlewareHandler } from "hono";
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
      return next();
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
        return next();
      }
    }

    if (options.localDevActor !== undefined) {
      bindActor(c, options.localDevActor);
      return next();
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

function extractOrgId(c: Context): string | undefined {
  return c.req.header("x-tanren-org-id") ?? c.req.query("orgId") ?? c.req.param("orgId");
}

function extractProjectId(c: Context): string | undefined {
  return c.req.header("x-tanren-project-id") ?? c.req.query("projectId") ?? c.req.param("projectId");
}
