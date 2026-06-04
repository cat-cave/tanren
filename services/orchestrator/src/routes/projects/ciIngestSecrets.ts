// CI-intelligence (PR2): the explicit trigger to propagate a project's CI INGEST
// secrets (Plane B) to the target repo's GitHub Actions repository SECRETS.
// `POST /orgs/:orgId/projects/:projectId/ci-ingest/propagate` sets the two
// repo-level Actions secrets the generated `tanren-ci.yml` upload step reads —
// the JUnit-upload signing key (`TANREN_RUN_TOKEN`, the SAME secret the ingest
// endpoint validates HMAC against) and the ingest base URL (`TANREN_INGEST_URL`)
// — so the project's CI `upload-junit` step authenticates against
// `POST /webhooks/ci/junit`. This mirrors the app-env propagation seam
// (`appEnvCi.ts`): the onboarding flow / an operator calls it on project setup.
//
// SECURITY: the route resolves the signing-key VALUE only inside
// `propagateCiIngestSecrets`, which transmits it ONLY in the encrypted
// Actions-secret PUT. The route response carries the secret NAMES only — never a
// value (the propagation makes no DB write, so nothing is persisted or logged).
// NO silent fallback: when CI ingest is enabled the signing-secret ref AND the
// public base URL are both required — a missing one is a LOUD 500 config error
// (`CiIngestSecretMissingError`), never a quiet skip.

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
import {
  CiIngestSecretMissingError,
  propagateCiIngestSecrets,
} from "../../engine/workflow/propagateCiIngestSecrets.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface CiIngestSecretsRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** Shared App-installation token minter (App-first credential resolution). */
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The SecretStore ref for the CI ingest HMAC signing key — the SAME ref the
   * JUnit ingest endpoint validates against. UNSET ⇒ CI ingest is not configured,
   * so the propagate endpoint stays UNMOUNTED (a route that could only ship a
   * never-authenticating workflow must not exist).
   */
  signingSecretRef?: string;
  /**
   * The public base URL the runner POSTs the JUnit report to. UNSET ⇒ the
   * endpoint stays unmounted (same reason).
   */
  publicBaseUrl?: string;
}

export function createCiIngestSecretsRoutes(options: CiIngestSecretsRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  // Only mount when CI ingest is fully configured (signing ref + public base URL):
  // a missing one means CI ingest cannot authenticate, so there is no propagation
  // to offer — a LOUD absence (404) rather than a route that ships a broken secret.
  const { signingSecretRef, publicBaseUrl } = options;
  if (signingSecretRef === undefined || publicBaseUrl === undefined) {
    return app;
  }

  app.post("/:orgId/projects/:projectId/ci-ingest/propagate", async (c) => {
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

    // Set the two repo-level Actions secrets on the target repo. This makes no DB
    // write (it is a provider-only call), so it needs no org-scoped tx; the project
    // was already tenant-gated above. The propagation surfaces the secret NAMES only.
    try {
      const result = await propagateCiIngestSecrets({
        secrets: options.secrets,
        vcsProvider: options.vcsProvider,
        repoUrl: project.repoUrl,
        token,
        signingSecretRef,
        publicBaseUrl,
      });
      // Response carries the propagated NAMES only — never a secret value.
      return c.json({ projectId, propagated: result.secretNames }, 200);
    } catch (error) {
      if (error instanceof CiIngestSecretMissingError) {
        return c.json({ error: "ci_ingest_misconfigured", message: error.message }, 500);
      }
      throw error;
    }
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
  options: CiIngestSecretsRoutesOptions,
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
