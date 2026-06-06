// Wave-2 operator API: human-drivable "Connect GitHub" + readiness routes,
// mirroring a real settings screen + an onboarding checklist. The gap this
// closes (found driving apex): to connect GitHub today an operator must
// hand-craft a raw `PATCH /orgs/:orgId` config with a `github_app` block
// (including an `installedAt` timestamp) or hand-set a `defaultCredentials`
// credential ref — nothing a real user does — and there is NO way to learn, up
// front, whether the connected identity can actually CREATE repos (greenfield
// needs `administration:write`), so greenfield fails late with a 403.
//
//   POST /orgs/:orgId/github          — connect GitHub (App install OR token).
//   GET  /orgs/:orgId/github          — the connected identity + its CAPABILITIES
//                                       (real check: canCreateRepos + missing).
//   GET  /orgs/:orgId/onboarding-status — the single readiness checklist.
//
// Org-scoped under RLS (the scoped pool); the writes require org-admin. The
// secret (App private key / PAT) is NEVER logged or returned — only refs and the
// non-secret `installedAt` (server-stamped) / login leave the boundary.

import { type Context, Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../../engine/config/orgConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { loadGithubAppCredential } from "../../engine/credentials/githubApp.js";
import { probeGithubAppCapability, probeGithubTokenCapability } from "../../engine/credentials/githubCapability.js";
import { storeGithubToken } from "../../engine/credentials/githubToken.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
  persistOrgDefaultGithubCredentialRef,
  persistOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { deriveCredentialRef } from "../../engine/credentials/refNamespace.js";
import { PgEventStore, type EventStore } from "../../engine/eventStore.js";
import { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "./access.js";

export interface GithubConnectRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Shared minter so installation-token caching spans routes. */
  minter?: GithubAppTokenMinter;
  /**
   * The Vault ref of the platform-managed GitHub App credential (appId +
   * private key). Used as the default when a connect-by-install request omits a
   * `credentialRef`. Mirrors `TANREN_GITHUB_APP_CREDENTIAL_REF`.
   */
  appCredentialRef?: string;
  /** Injectable fetch for the capability probe (real GitHub by default). */
  fetchImpl?: typeof fetch;
  /** Event append seam for credential repair signals; defaults to PgEventStore. */
  events?: EventStore;
}

// Connect-by-App-install: GitHub gives the operator an `installationId` (+ the
// App `appId`); the App private key is already a managed credential (or the
// caller names its `credentialRef`). The operator MUST NOT supply a timestamp —
// `installedAt` is server-stamped.
const InstallConnectSchema = z
  .object({
    installationId: z.string().min(1),
    appId: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
  })
  .strict();

// Connect-by-token: a raw PAT. Stored as a `github_token` credential under the
// org's namespace and set as the org's default GitHub credential.
const TokenConnectSchema = z.object({ token: z.string().min(1) }).strict();

export function createGithubConnectRoutes(options: GithubConnectRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const minter = options.minter ?? new GithubAppTokenMinter({ secrets: options.secrets });
  const events = options.events ?? new PgEventStore(options.pool);

  // POST /:orgId/github — connect GitHub. Body discriminates the two modes:
  //   { installationId, appId, credentialRef? } → App install
  //   { token }                                 → static token
  app.post("/:orgId/github", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const raw = (await c.req.json().catch(() => {})) as unknown;

    const install = InstallConnectSchema.safeParse(raw);
    if (install.success) {
      return connectViaApp(c, options, minter, events, orgId, install.data);
    }
    const token = TokenConnectSchema.safeParse(raw);
    if (token.success) {
      return connectViaToken(c, options, events, actor, orgId, token.data.token);
    }
    // Neither shape matched — report the install-mode issues (the richer schema)
    // so the caller sees what a valid body looks like; the secret never echoes.
    return c.json({ error: "invalid_github_connect", issues: install.error.issues }, 400);
  });

  // GET /:orgId/github — the connected identity + a REAL capability check.
  app.get("/:orgId/github", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    let status: GithubConnectionStatus;
    try {
      status = await resolveGithubConnection(options, minter, orgId);
    } catch (error) {
      return c.json({ error: "github_capability_check_failed", message: messageOf(error) }, 502);
    }
    return c.json(status);
  });

  // GET /:orgId/onboarding-status — the single readiness checklist.
  app.get("/:orgId/onboarding-status", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const configResult = await options.pool.query<{ config: unknown }>(
      "SELECT config FROM organizations WHERE id = $1",
      [orgId],
    );
    if (configResult.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const config = migrateOrgConfig(configResult.rows[0].config);

    let github: GithubConnectionStatus;
    try {
      github = await resolveGithubConnection(options, minter, orgId);
    } catch (error) {
      return c.json({ error: "github_capability_check_failed", message: messageOf(error) }, 502);
    }
    return c.json(composeOnboardingStatus(config, github));
  });

  return app;
}

interface GithubConnectionStatus {
  connected: boolean;
  mode: "app" | "token" | null;
  login: string | null;
  canCreateRepos: boolean;
  missingPermissions: string[];
}

/**
 * Resolve the org's connected GitHub identity + its capabilities. Prefers the
 * App installation (the long-term model) over a static token, mirroring the
 * token resolver's precedence. The capability probe is a REAL call against the
 * resolved credential — never a guess.
 */
async function resolveGithubConnection(
  options: GithubConnectRoutesOptions,
  minter: GithubAppTokenMinter,
  orgId: string,
): Promise<GithubConnectionStatus> {
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  if (installation !== undefined) {
    const capability = await probeGithubAppCapability({
      secrets: options.secrets,
      installation,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return { connected: true, mode: "app", ...capability };
  }
  const staticRef = await loadOrgDefaultGithubCredentialRef(options.pool, orgId);
  if (staticRef !== undefined) {
    const secret = await options.secrets.get(staticRef);
    if (secret === undefined) {
      // The ref points at nothing — a configuration error, not a live identity.
      return { connected: false, mode: null, login: null, canCreateRepos: false, missingPermissions: [] };
    }
    const capability = await probeGithubTokenCapability({
      token: secret.value,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return { connected: true, mode: "token", ...capability };
  }
  return { connected: false, mode: null, login: null, canCreateRepos: false, missingPermissions: [] };
}

/**
 * App-install connect: verify the App can mint an installation token (and read
 * the App credential's id) BEFORE persisting, then write the `github_app` block
 * with a SERVER-STAMPED `installedAt` through the shared config path. The
 * supplied `appId` must match the credential's own id — a mismatch is a loud
 * 400, never a silently-wrong write.
 */
async function connectViaApp(
  c: Context<ActorContextEnv>,
  options: GithubConnectRoutesOptions,
  minter: GithubAppTokenMinter,
  events: EventStore,
  orgId: string,
  body: z.infer<typeof InstallConnectSchema>,
): Promise<Response> {
  const credentialRef = body.credentialRef ?? options.appCredentialRef;
  if (credentialRef === undefined || credentialRef === "") {
    return c.json({ error: "github_app_credential_unconfigured" }, 400);
  }

  let appId: string;
  try {
    const credential = await loadGithubAppCredential(options.secrets, credentialRef);
    appId = credential.appId;
    if (appId !== body.appId) {
      return c.json({ error: "github_app_id_mismatch" }, 400);
    }
    await minter.refreshInstallationToken({ installationId: body.installationId, credentialRef });
  } catch (error) {
    return c.json({ error: "github_app_install_verification_failed", message: messageOf(error) }, 502);
  }

  const installation: OrgGithubAppInstallation = {
    installationId: body.installationId,
    appId,
    credentialRef,
    // SERVER-STAMPED: the operator must NOT supply a timestamp.
    installedAt: new Date().toISOString(),
  };
  const persisted = await persistOrgGithubAppInstallation(options.pool, orgId, installation);
  if (!persisted) {
    return c.json({ error: "org_not_found" }, 404);
  }
  await emitGithubConfiguredForOrgProjects(options, events, orgId, {
    mode: "app",
    credentialKind: "github_app",
    ref: credentialRef,
    redacted: true,
  });
  return c.json(
    {
      ok: true,
      mode: "app",
      installation: { installationId: installation.installationId, appId, installedAt: installation.installedAt },
    },
    201,
  );
}

/**
 * Token connect: validate + store the PAT as a `github_token` credential under
 * the org's namespace, then set it as the org's default GitHub credential. The
 * raw token never appears in the response (only the redacted ref) or a log.
 */
async function connectViaToken(
  c: Context<ActorContextEnv>,
  options: GithubConnectRoutesOptions,
  events: EventStore,
  actor: ActorContext,
  orgId: string,
  token: string,
): Promise<Response> {
  // Derive the canonical org-namespaced ref server-side (never a caller ref).
  const ref = deriveCredentialRef({ kind: "github_token", scope: "org", ownerId: orgId, name: "default" });
  try {
    await storeGithubToken(options.secrets, { ref, token });
  } catch (error) {
    return c.json({ error: "invalid_github_token", message: messageOf(error) }, 400);
  }
  const persisted = await persistOrgDefaultGithubCredentialRef(options.pool, orgId, ref);
  if (!persisted) {
    // Roll back the orphaned secret so a failed connect leaves no dangling key.
    await options.secrets.delete(ref).catch(() => {});
    return c.json({ error: "org_not_found" }, 404);
  }
  await emitGithubConfiguredForOrgProjects(options, events, orgId, {
    mode: "token",
    credentialKind: "github_token",
    ref,
    redacted: true,
  });
  return c.json({ ok: true, mode: "token", credentialRef: ref, redacted: true }, 201);
}

async function emitGithubConfiguredForOrgProjects(
  options: GithubConnectRoutesOptions,
  events: EventStore,
  orgId: string,
  payload: {
    mode: "app" | "token";
    credentialKind: "github_app" | "github_token";
    ref: string;
    redacted: true;
  },
): Promise<void> {
  const projects = await options.pool.query<{ project_id: string }>(
    "SELECT project_id FROM projects WHERE org_id = $1",
    [orgId],
  );
  await Promise.all(
    projects.rows.map((project) =>
      events.append({
        projectId: project.project_id,
        eventType: "credential.github.configured",
        payload,
      }),
    ),
  );
}

interface AiProviderStatus {
  connected: boolean;
  classifiedAs?: string;
}

interface OnboardingStatus {
  aiProvider: AiProviderStatus;
  github: { connected: boolean; canCreateRepos: boolean };
  budget: { ceilingUsd: number | null };
  ready: boolean;
  nextSteps: string[];
}

/**
 * Compose the readiness checklist from the org config + the resolved GitHub
 * connection. Read-only; aggregates the EXISTING config reads (AI provider,
 * GitHub, budget) into the single view a non-expert uses to know what is
 * configured and what is missing.
 */
function composeOnboardingStatus(
  config: ReturnType<typeof migrateOrgConfig>,
  github: GithubConnectionStatus,
): OnboardingStatus {
  const aiProvider = resolveAiProviderStatus(config);
  const ceilingUsd = config.defaultBudget?.ceilingUsd ?? null;

  const nextSteps: string[] = [];
  if (!aiProvider.connected) {
    nextSteps.push("Connect an AI provider: import a Codex credential (or enable managed provider).");
  }
  if (!github.connected) {
    nextSteps.push("Connect GitHub: POST /orgs/:orgId/github with an App installation or a token.");
  } else if (!github.canCreateRepos) {
    nextSteps.push(
      `Grant repo-creation: the connected GitHub identity is missing ${github.missingPermissions.join(", ")} (required for greenfield).`,
    );
  }
  if (ceilingUsd === null) {
    nextSteps.push("Set a default budget ceiling: PUT /orgs/:orgId/budget so runs have a spend cap.");
  }

  // Ready to drive a (brownfield) run when an AI provider and GitHub are both
  // connected. Repo-creation + budget are surfaced as next steps but do not gate
  // baseline readiness (greenfield needs canCreateRepos; budget is recommended).
  const ready = aiProvider.connected && github.connected;
  return {
    aiProvider,
    github: { connected: github.connected, canCreateRepos: github.canCreateRepos },
    budget: { ceilingUsd },
    ready,
    nextSteps,
  };
}

/**
 * The AI-provider connectivity signal from org config: a managed provider is
 * connected by the platform; otherwise a connected BYOK provider is one whose
 * default Codex credential is set. `classifiedAs` names which.
 */
function resolveAiProviderStatus(config: ReturnType<typeof migrateOrgConfig>): AiProviderStatus {
  if (config.providerMode === "managed") {
    return { connected: true, classifiedAs: "managed" };
  }
  if (config.defaultCredentials?.codex_chatgpt_auth !== undefined) {
    return { connected: true, classifiedAs: "codex" };
  }
  return { connected: false };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
