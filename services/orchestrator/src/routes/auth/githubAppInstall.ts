// P3-0003: GitHub App install-onboarding flow, mirroring the OAuth login flow
// in `routes/auth/index.ts` (state cookie → authorize redirect → callback →
// persist to the org).
//
//   GET /auth/github-app/install?orgId=…
//     Sets a state cookie carrying the org id and redirects the operator to
//     the GitHub App installation URL.
//
//   GET /auth/github-app/callback?installation_id=…&state=…
//     GitHub redirects here after the operator picks repos. We validate the
//     state cookie, verify the App can mint a token for the installation, and
//     persist `{ installationId, appId, credentialRef, installedAt }` to
//     `organizations.config.github_app`.
//
// The App private key lives ONLY in Vault under `credentialRef`; this flow
// never touches it directly — it asks the minter to verify access.

import { randomBytes } from "node:crypto";
import { runWithSystemScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { OrgGithubAppInstallation } from "../../engine/config/orgConfig.js";
import { loadGithubAppCredential } from "../../engine/credentials/githubApp.js";
import { persistOrgGithubAppInstallation } from "../../engine/credentials/orgGithubApp.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { readCookie, type ActorContextEnv } from "../../middleware/auth.js";

const STATE_COOKIE = "tanren_github_app_state";

export interface GithubAppInstallRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Vault ref where the App credential (appId + private key) is stored. */
  appCredentialRef: string;
  /** Base GitHub App install URL, e.g. https://github.com/apps/<slug>/installations/new */
  installUrl: string;
  minter?: GithubAppTokenMinter;
  cookieSecure?: boolean;
}

const installQuerySchema = z.object({ orgId: z.string().min(1) });
const callbackQuerySchema = z.object({
  installation_id: z.string().min(1),
  state: z.string().min(1),
});

export function createGithubAppInstallRoutes(options: GithubAppInstallRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const minter = options.minter ?? new GithubAppTokenMinter({ secrets: options.secrets });

  app.get("/install", async (c) => {
    const parsed = installQuerySchema.safeParse({ orgId: c.req.query("orgId") });
    if (!parsed.success) {
      return c.json({ error: "invalid_install", issues: parsed.error.issues }, 400);
    }
    // SECURITY (H1): installing/overwriting an org's GitHub App is an org-config
    // write, so the authenticated actor MUST be an admin of the TARGET org — a
    // missing actor or a non-admin is a LOUD 403, never a permissive default.
    // The org id comes from the request (the `?orgId=` query), NOT from the
    // actor's middleware-resolved scope, so we re-authorize it directly.
    const actor = requireActor(c);
    if (!(await actorIsOrgAdmin(options.pool, actor, parsed.data.orgId))) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    // The state cookie carries a nonce + the org id so the callback (which only
    // receives `installation_id`/`state` from GitHub) knows which org to bind.
    const nonce = randomBytes(24).toString("hex");
    const state = `${nonce}.${parsed.data.orgId}`;
    c.header("Set-Cookie", stateCookie(state, options.cookieSecure));
    return c.redirect(options.installUrl);
  });

  app.get("/callback", async (c) => {
    const parsed = callbackQuerySchema.safeParse({
      installation_id: c.req.query("installation_id"),
      state: c.req.query("state"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_callback", issues: parsed.error.issues }, 400);
    }
    const cookieState = readCookie(c, STATE_COOKIE);
    if (cookieState === undefined || cookieState !== parsed.data.state) {
      return c.json({ error: "state_mismatch" }, 400);
    }
    const orgId = parsed.data.state.split(".").slice(1).join(".");
    if (orgId === "") {
      return c.json({ error: "state_mismatch" }, 400);
    }

    // SECURITY (H1): the target org is carried in the (HttpOnly, state-matched)
    // cookie, not the actor's middleware-resolved scope, so re-authorize it
    // here: the authenticated actor MUST be an admin of THIS org before we
    // overwrite its `config.github_app`. A non-admin (or no actor) is a LOUD
    // 403 — never a silent write through the raw pool.
    const actor = requireActor(c);
    if (!(await actorIsOrgAdmin(options.pool, actor, orgId))) {
      return c.json({ error: "org_access_denied" }, 403);
    }

    // Verify the App can actually mint an installation token (and read the
    // App credential's id) before we persist anything.
    let appId: string;
    try {
      const credential = await loadGithubAppCredential(options.secrets, options.appCredentialRef);
      appId = credential.appId;
      await minter.refreshInstallationToken({
        installationId: parsed.data.installation_id,
        credentialRef: options.appCredentialRef,
      });
    } catch (error) {
      return c.json({ error: "install_verification_failed", message: messageOf(error) }, 502);
    }

    const installation: OrgGithubAppInstallation = {
      installationId: parsed.data.installation_id,
      appId,
      credentialRef: options.appCredentialRef,
      installedAt: new Date().toISOString(),
    };
    const persisted = await persistOrgGithubAppInstallation(options.pool, orgId, installation);
    if (!persisted) {
      return c.json({ error: "org_not_found" }, 404);
    }
    c.header("Set-Cookie", clearStateCookie());
    return c.json({
      ok: true,
      orgId,
      installation: {
        installationId: installation.installationId,
        appId,
        installedAt: installation.installedAt,
      },
    });
  });

  return app;
}

/**
 * Mounts the install routes on `app` at `/auth/github-app` only when the App is
 * configured via env (`TANREN_GITHUB_APP_INSTALL_URL` +
 * `TANREN_GITHUB_APP_CREDENTIAL_REF`). No-op otherwise, so tests/dev fall back
 * to the static-token path. Keeps `main.ts` compact (500-line cap).
 */
export function mountGithubAppInstallFromEnv(
  app: Hono<ActorContextEnv>,
  deps: { pool: pg.Pool; secrets: SecretStore; minter: GithubAppTokenMinter },
): void {
  const installUrl = process.env["TANREN_GITHUB_APP_INSTALL_URL"];
  const appCredentialRef = process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"];
  if (installUrl === undefined || installUrl === "" || appCredentialRef === undefined || appCredentialRef === "") {
    return;
  }
  app.route(
    "/auth/github-app",
    createGithubAppInstallRoutes({
      pool: deps.pool,
      secrets: deps.secrets,
      appCredentialRef,
      installUrl,
      minter: deps.minter,
      cookieSecure: process.env["TANREN_COOKIE_SECURE"] === "1",
    }),
  );
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    // The auth middleware admits no unauthenticated request to a mounted route,
    // so a missing actor here is a wiring fault — fail loud, never permissive.
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

/**
 * SECURITY (H1): is `actor` an admin of `orgId`? `platform:admin` always passes.
 * Otherwise we read the actor's role from `org_members` directly — the target
 * org is request-supplied (install query / callback cookie), so we must NOT lean
 * on the actor's middleware-resolved scope (which is keyed to whatever org the
 * middleware happened to resolve). `org_members` is RLS deny-by-default and this
 * membership lookup precedes any org scope, so — exactly like
 * `resolveActorContext` / `ensureOrgMembership` — it runs system-scoped. A
 * non-member or non-admin resolves to `false` → the caller returns 403.
 */
async function actorIsOrgAdmin(pool: pg.Pool, actor: ActorContext, orgId: string): Promise<boolean> {
  if (actor.scopes.includes("platform:admin")) return true;
  const result = await runWithSystemScope(pool, (client) =>
    client.query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [
      orgId,
      actor.userId,
    ]),
  );
  return result.rows[0]?.role === "admin";
}

function stateCookie(value: string, secure?: boolean): string {
  const parts = [`${STATE_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600"];
  if (secure === true) parts.push("Secure");
  return parts.join("; ");
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
