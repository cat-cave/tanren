// P-APP-ENV-1: the explicit trigger to propagate a project's TEST-scoped app
// environment (Plane B) to the target repo's GitHub Actions repository SECRETS.
// `POST /orgs/:orgId/projects/:projectId/app-env/propagate-ci` resolves the
// project's `tanren-ci.yml` test secrets (e.g. `RESEND_API_KEY`) from the App
// Environment store and sets each as an Actions secret on the repo, so the
// project's CI tests that read them pass. This is the clean seam (an operator /
// the onboarding flow calls it on project setup or whenever the app-env changes);
// it does not piggyback on the project-config PATCH (config is non-secret, app-env
// secrets are a distinct surface).
//
// SECURITY: the route resolves secret VALUES only inside `propagateAppEnvToCi`,
// which transmits each ONLY in the encrypted Actions-secret PUT. The route
// response + the emitted signal carry the secret NAMES only — never a value.
// Org-scoped: the app-env read runs under `runWithOrgScope`, so RLS gates which
// project's entries are visible (an off-scope client sees zero rows).

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { migrateProjectConfig } from "../../engine/config/projectConfig.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { VcsCredentialContext, VcsProvider } from "../../engine/contracts/vcsProvider.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import { propagateAppEnvToCi } from "../../engine/workflow/propagateAppEnvToCi.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface AppEnvCiRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** Shared App-installation token minter (App-first credential resolution). */
  githubAppMinter?: GithubAppTokenMinter;
}

export function createAppEnvCiRoutes(options: AppEnvCiRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/projects/:projectId/app-env/propagate-ci", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }

    // Resolve + tenant-gate the project (its repo URL + the project static cred ref).
    const project = await ProjectStore.get(options.pool, projectId, systemActor);
    if (project === undefined) {
      return c.json({ error: "project_not_found" }, 404);
    }
    const ownership = await ProjectStore.getOwnership(options.pool, projectId, systemActor);
    if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
      return c.json({ error: "project_not_found" }, 404);
    }

    // Credential context: App-first (the org installation), else the project's
    // bound static github credential ref, else the org default — the provider owns
    // the App-first/static policy + the hard-throw when neither is configured.
    const creds = await buildVcsCredentialContext(options, orgId, project.config);
    const token = await options.vcsProvider.resolveToken(creds);

    // The app-env read MUST run org-scoped so RLS gates which project's entries are
    // visible. The propagation resolves test-scoped values + sets each Actions secret.
    const result = await runWithOrgScope(options.pool, orgId, async (client) =>
      propagateAppEnvToCi({
        client,
        secrets: options.secrets,
        vcsProvider: options.vcsProvider,
        repoUrl: project.repoUrl,
        projectId,
        token,
        actor: systemActor,
        // Names-only emitter — never a value (the structured app log, the same
        // channel run-lifecycle structured signals use). Kept off the typed event
        // store so this needs no migration.
        emit: (event) => {
          process.stdout.write(`${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`);
        },
      }),
    );

    // Response carries the propagated NAMES only — never a secret value.
    return c.json({ projectId, propagated: result.secretNames }, 200);
  });

  return app;
}

/**
 * Build the per-repo credential context: prefer the org's GitHub App installation;
 * otherwise resolve a static credential ref — the project's bound
 * `githubCredentialRef` if set, else the org default github token. The provider's
 * `resolveToken` hard-throws when neither an installation nor a static ref is
 * available (no hardcoded default).
 */
async function buildVcsCredentialContext(
  options: AppEnvCiRoutesOptions,
  orgId: string,
  projectConfig: unknown,
): Promise<VcsCredentialContext> {
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  if (installation !== undefined) {
    return {
      secrets: options.secrets,
      installation,
      ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
    };
  }
  const projectRef = migrateProjectConfig(projectConfig).credentials?.githubCredentialRef;
  const staticRef = projectRef ?? (await loadOrgDefaultGithubCredentialRef(options.pool, orgId));
  return {
    secrets: options.secrets,
    ...(staticRef === undefined ? {} : { staticRef }),
  };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
