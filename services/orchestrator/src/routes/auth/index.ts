import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { IdentityProvider } from "../../auth/identityProvider.js";
import { IdentityProviderError } from "../../auth/identityProvider.js";
import type { IdentityStore } from "../../auth/identityStore.js";
import type { IdentityProviderId } from "../../auth/schemas.js";
import {
  clearSessionCookie,
  readCookie,
  setSessionCookie,
  SESSION_COOKIE,
  type ActorContextEnv,
} from "../../middleware/auth.js";

const STATE_COOKIE = "tanren_oauth_state";
const CLI_STATE_COOKIE = "tanren_cli_state";

export interface AuthRoutesOptions {
  providers: Map<IdentityProviderId, IdentityProvider>;
  store: IdentityStore;
  /** Absolute base url the orchestrator is reachable at — used to compute the OAuth redirect_uri. */
  publicBaseUrl: string;
  /** Set Secure on cookies (prod). */
  cookieSecure?: boolean;
  /**
   * CANONICAL GitHub App install URL (TANREN_GITHUB_APP_INSTALL_URL). Echoed on
   * `/auth/providers` so the dashboard reads the install URL FROM the orchestrator
   * rather than carrying its own env copy — one source of truth for the name.
   */
  githubAppInstallUrl?: string;
}

const loginQuerySchema = z.object({
  provider: z.enum(["github_oauth", "oidc", "local_dev"]).default("github_oauth"),
  next: z.string().optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  provider: z.enum(["github_oauth", "oidc", "local_dev"]).default("github_oauth"),
});

const cliStartQuerySchema = z.object({
  provider: z.enum(["github_oauth", "oidc", "local_dev"]).default("github_oauth"),
  name: z.string().min(1).optional(),
});

const cliCompleteBodySchema = z.object({
  name: z.string().min(1).default("cli"),
  scopes: z.array(z.enum(["read", "write", "admin"])).default(["read", "write"]),
});

export function createAuthRoutes(options: AuthRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/providers", (c) => {
    return c.json({
      providers: [...options.providers.keys()].map((id) => ({ id })),
      // The canonical GitHub App install URL (when configured) — the dashboard
      // reads it from here instead of its own env. Omitted when unconfigured.
      ...(options.githubAppInstallUrl !== undefined && { githubAppInstallUrl: options.githubAppInstallUrl }),
    });
  });

  app.get("/login", (c) => {
    const parsed = loginQuerySchema.safeParse({
      provider: c.req.query("provider"),
      next: c.req.query("next"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_login", issues: parsed.error.issues }, 400);
    }
    const provider = options.providers.get(parsed.data.provider);
    if (provider === undefined) {
      return c.json({ error: "provider_not_configured", provider: parsed.data.provider }, 404);
    }
    const state = randomBytes(24).toString("hex");
    const redirectUri = `${options.publicBaseUrl}/auth/callback?provider=${parsed.data.provider}`;
    const authorizeUrl = provider.buildAuthorizeUrl(state, redirectUri);
    c.header("Set-Cookie", stateCookie(STATE_COOKIE, state, options.cookieSecure));
    return c.redirect(authorizeUrl);
  });

  app.get("/callback", async (c) => {
    const parsed = callbackQuerySchema.safeParse({
      code: c.req.query("code"),
      state: c.req.query("state"),
      provider: c.req.query("provider"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_callback", issues: parsed.error.issues }, 400);
    }
    const stateCookieValue = readCookie(c, STATE_COOKIE);
    if (stateCookieValue !== parsed.data.state) {
      return c.json({ error: "state_mismatch" }, 400);
    }
    const provider = options.providers.get(parsed.data.provider);
    if (provider === undefined) {
      return c.json({ error: "provider_not_configured", provider: parsed.data.provider }, 404);
    }
    try {
      const redirectUri = `${options.publicBaseUrl}/auth/callback?provider=${parsed.data.provider}`;
      const claims = await provider.exchangeCode(parsed.data.code, redirectUri);
      const { user, orgs, primaryOrgId } = await options.store.upsertIdentity(provider.id, claims);
      const session = await options.store.createSession(user.id, {
        ip: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      });
      c.header("Set-Cookie", setSessionCookie(session.id, { secure: options.cookieSecure }), {
        append: true,
      });
      c.header("Set-Cookie", clearStateCookie(STATE_COOKIE), { append: true });
      return c.json({
        ok: true,
        user: { id: user.id, login: user.login, email: user.email, displayName: user.displayName },
        orgs: orgs.map((org) => ({ id: org.id, login: org.login, displayName: org.displayName })),
        primaryOrgId,
        csrfToken: session.csrfToken,
      });
    } catch (error) {
      if (error instanceof IdentityProviderError) {
        const status = error.statusCode === 501 ? 501 : 502;
        return c.json({ error: "provider_error", message: error.message }, status);
      }
      throw error;
    }
  });

  app.get("/me", async (c) => {
    const sessionId = readCookie(c, SESSION_COOKIE);
    if (sessionId === undefined) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const session = await options.store.loadSession(sessionId);
    if (session === undefined) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    return c.json({
      userId: session.userId,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post("/logout", async (c) => {
    const sessionId = readCookie(c, SESSION_COOKIE);
    if (sessionId !== undefined) {
      await options.store.deleteSession(sessionId);
    }
    c.header("Set-Cookie", clearSessionCookie());
    return c.json({ ok: true });
  });

  app.get("/cli/start", (c) => {
    const parsed = cliStartQuerySchema.safeParse({
      provider: c.req.query("provider"),
      name: c.req.query("name"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_cli_start", issues: parsed.error.issues }, 400);
    }
    const provider = options.providers.get(parsed.data.provider);
    if (provider === undefined) {
      return c.json({ error: "provider_not_configured", provider: parsed.data.provider }, 404);
    }
    const state = randomBytes(24).toString("hex");
    const redirectUri = `${options.publicBaseUrl}/auth/callback?provider=${parsed.data.provider}`;
    c.header("Set-Cookie", stateCookie(CLI_STATE_COOKIE, state, options.cookieSecure));
    return c.json({
      authorizeUrl: provider.buildAuthorizeUrl(state, redirectUri),
      completeUrl: `${options.publicBaseUrl}/auth/cli/complete`,
      state,
    });
  });

  app.post("/cli/complete", async (c) => {
    const sessionId = readCookie(c, SESSION_COOKIE);
    if (sessionId === undefined) {
      return c.json({ error: "session_required", message: "complete login in the browser first" }, 401);
    }
    const session = await options.store.loadSession(sessionId);
    if (session === undefined) {
      return c.json({ error: "session_required" }, 401);
    }
    const parsed = cliCompleteBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_cli_complete", issues: parsed.error.issues }, 400);
    }
    const token = await options.store.createApiToken({
      userId: session.userId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
    });
    c.header("Set-Cookie", clearStateCookie(CLI_STATE_COOKIE));
    return c.json({ id: token.id, token: token.rawToken, name: parsed.data.name, scopes: parsed.data.scopes }, 201);
  });

  return app;
}

function stateCookie(name: string, value: string, secure?: boolean): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600"];
  if (secure === true) parts.push("Secure");
  return parts.join("; ");
}

function clearStateCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}
