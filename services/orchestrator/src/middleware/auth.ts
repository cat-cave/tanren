import type { Context, MiddlewareHandler } from "hono";
import type { ActorContext } from "../auth/schemas.js";
import type { IdentityStore } from "../auth/identityStore.js";

export const SESSION_COOKIE = "tanren_session";
export const CSRF_HEADER = "x-csrf-token";

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/version",
  "/auth/login",
  "/auth/callback",
  "/auth/providers",
  "/auth/cli/start",
  "/auth/cli/complete"
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
        platformAdminUserIds: options.platformAdminUserIds
      });
      c.set("actor", actor);
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
          platformAdminUserIds: options.platformAdminUserIds
        });
        c.set("actor", actor);
        return next();
      }
    }

    if (options.localDevActor !== undefined) {
      c.set("actor", options.localDevActor);
      return next();
    }

    return c.json({ error: "unauthorized", message: "authentication required" }, 401);
  };
}

function extractBearer(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie");
  if (header === undefined) {
    return undefined;
  }
  for (const piece of header.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    if (piece.slice(0, eq) === name) {
      return decodeURIComponent(piece.slice(eq + 1));
    }
  }
  return undefined;
}

export function setSessionCookie(value: string, options: { secure?: boolean; maxAgeSeconds?: number } = {}): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
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
