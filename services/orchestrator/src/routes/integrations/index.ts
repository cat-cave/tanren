// the capability-driven onboarding HTTP surface (orchestrator side).
//
//   GET /:orgId/integrations
//     List the org's linked provider grants (Plane A). Credential REF names +
//     metadata KEYS only — never secret values or metadata values. Empty list
//     when nothing is linked (200). Org-scoped via actorCanAccessOrg.
//
//   POST /:orgId/projects/:projectId/integrations/provision
//     Body: { capability, providerKind?, mode, chosenResourceId?, stack?, name? }.
//     Requests a CAPABILITY ("enable error tracking", "notify on Slack",
//     "deploy") for the project — NOT a leaf secret. The engine resolves the org
//     active control grant, builds the provisioner with PRODUCTION deps,
//     applies confirm-with-smart-default (discover → create/bind), persists the
//     artifact over the existing surfaces, emits `integration.provisioned`, and
//     returns what was created/bound BY REFERENCE (never a secret value).
//
//     - Org hasn't linked the provider → 200 with `{ status: "not_linked", ... }`
//       carrying a link-first message + a deep-link affordance (a structured
//       response the dashboard renders, NOT a crash / 5xx).
//     - Provisioned/bound → 201 with the refs (secret REF NAMES, surface ids,
//       projectConfig keys, deployRef) — no secret material.
//
//   GET /:orgId/projects/:projectId/integrations/discover
//     Query: { capability, providerKind? }. Lists the org's existing resources of
//     this kind so the dashboard can render the smart-default picker before any
//     provider write. Returns `not_linked` (link-first) when no grant exists.
//
// The route shape is intentionally clean for the dashboard two-plane UI:
// link-provider-once (org) → enable-capability-per-project. Production wires
// the configured SecretStore + the real provisioner registry; tests drive the
// engine directly with a fake provisioner.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { PgEventStore } from "../../engine/eventStore.js";
import {
  buildIntegrationProvisioner,
  type IntegrationProvisioner,
} from "../../engine/contracts/integrationProvisioner.js";
import {
  capabilitiesForProviderKind,
  productionProvisionerDeps,
  provisionCapability,
  resolveProviderKind,
} from "../../engine/integrations/provisioningEngine.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import { IntegrationLifecycleInventoryStore } from "../../engine/repositories/integrationLifecycleInventory.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface IntegrationRoutesOptions {
  pool: pg.Pool;
  /** The configured SecretStore the production provisioner deps run over. */
  secrets: SecretStore;
}

const ProvisionMode = z.enum(["greenfield", "brownfield"]);

// The integration-LINK body ("connect Vercel/Fly/Slack/Sentry"): the provider TOKEN
// (stored in the SecretStore by ref — never persisted as a value or echoed) + the
// non-secret org metadata the provisioner runs under (Vercel teamId/slug, Fly
// orgSlug + image, Sentry org slug). Org-admin only.
const LinkBody = z
  .object({
    token: z.string().min(1).max(4096),
    upstreamAccountId: z.string().min(1).max(200),
    authKind: z.enum(["api_key", "oauth2", "bot_token", "webhook", "workload_identity"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ProvisionBody = z
  .object({
    capability: z.string().min(1).max(64),
    providerKind: z.string().min(1).max(64).optional(),
    mode: ProvisionMode,
    chosenResourceId: z.string().min(1).max(200).optional(),
    stack: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export function createIntegrationRoutes(options: IntegrationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const events = new PgEventStore(options.pool);

  // GET /:orgId/integrations — list Plane-A grants for the org. Refs + status +
  // capability tags only; metadata VALUES and secret VALUES never leave the
  // store. Empty array when nothing is linked (a successful "no grants yet").
  app.get("/:orgId/integrations", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.query("projectId");
    const operator = { kind: "operator" as const, id: actor.userId };
    const { rows, lifecycle } = await runWithOrgScope(options.pool, orgId, async (client) => ({
      rows: await IntegrationConnectionsStore.listControlGrants(client, orgId, operator),
      lifecycle:
        projectId === undefined || projectId === ""
          ? undefined
          : await IntegrationLifecycleInventoryStore.getForProject(client, orgId, projectId, operator),
    }));
    if (projectId !== undefined && projectId !== "" && lifecycle === undefined) {
      return c.json({ error: "project_not_found" }, 404);
    }
    const integrations = rows.map((row) => ({
      connectionId: row.connectionId,
      grantId: row.grantId,
      orgId: row.orgId,
      providerKind: row.providerKind,
      upstreamAccountId: row.upstreamAccountId,
      authKind: row.authKind,
      authGeneration: row.authGeneration,
      ownerId: row.ownerId,
      metadataKeys: Object.keys(row.metadata),
      capabilities: row.capabilities,
      operations: row.operations,
      providerScopes: row.providerScopes,
      health: row.health,
      connectionStatus: row.connectionStatus,
      grantGeneration: row.grantGeneration,
      grantStatus: row.grantStatus,
    }));
    return c.json({ integrations, ...(lifecycle === undefined ? {} : { lifecycle }) }, 200);
  });

  app.post("/:orgId/projects/:projectId/integrations/provision", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ProvisionBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_provision", issues: parsed.error.issues }, 400);
    }
    // A capability/provider pairing that cannot resolve is a 400 (programmer
    // error), distinct from the expected not-linked case (a 200 link-first).
    try {
      resolveProviderKind(parsed.data.capability, parsed.data.providerKind);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    try {
      const outcome = await runWithOrgScope(options.pool, orgId, (client) =>
        provisionCapability(
          {
            client,
            secrets: options.secrets,
            events,
            actor: { kind: "operator", id: actor.userId },
          },
          { projectId, orgId, ...parsed.data },
        ),
      );
      // not_linked is a successful, structured response (not an error path).
      return c.json(outcome, outcome.status === "not_linked" ? 200 : 201);
    } catch (error) {
      return c.json({ error: "provision_failed", message: messageOf(error) }, 500);
    }
  });

  // POST /:orgId/integrations/:providerKind — LINK an org integration grant. The
  // API-drivable "connect Vercel/Fly/Slack/Sentry" surface: validates + stores the
  // provider token in the SecretStore (REF only), creates the connection authority,
  // and links its active control grant so `provision`/`discover` then work.
  // Org-ADMIN gated (a write); a non-admin → 403. The token VALUE is never echoed,
  // logged, or placed in an event — only its ref name.
  app.post("/:orgId/integrations/:providerKind", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const providerKind = c.req.param("providerKind");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    let capabilities: string[];
    try {
      capabilities = capabilitiesForProviderKind(providerKind);
    } catch (error) {
      return c.json({ error: "unknown_provider_kind", message: messageOf(error) }, 400);
    }
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_link", issues: parsed.error.issues }, 400);
    }
    try {
      // Store the token under a stable, org+provider-scoped ref. The VALUE lives ONLY
      // in the SecretStore; the grant + event carry the ref name alone.
      const credentialRef = `secret://org/${orgId}/integration/${providerKind}/token`;
      await options.secrets.put({ ref: credentialRef, value: parsed.data.token });
      const grant = await runWithOrgScope(options.pool, orgId, (client) =>
        IntegrationConnectionsStore.linkControlGrant(
          client,
          {
            orgId,
            providerKind,
            upstreamAccountId: parsed.data.upstreamAccountId,
            authKind: parsed.data.authKind,
            credentialRef,
            metadata: parsed.data.metadata ?? {},
            capabilities,
          },
          { kind: "operator", id: actor.userId },
        ),
      );
      // The grant upsert IS the durable audit record (org-scoped under RLS); no
      // `events` append here — `events` is project-scoped (its org_id derives from a
      // project), and an org-level link has no project to scope the row to.
      // Refs only — never the token value.
      return c.json(
        {
          status: "linked",
          providerKind,
          connectionId: grant.connectionId,
          grantId: grant.grantId,
          authGeneration: grant.authGeneration,
          grantGeneration: grant.grantGeneration,
          capabilities,
          metadataKeys: Object.keys(grant.metadata),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: "link_failed", message: messageOf(error) }, 500);
    }
  });

  app.get("/:orgId/projects/:projectId/integrations/discover", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const capability = c.req.query("capability") ?? "";
    const providerKindQuery = c.req.query("providerKind");
    let providerKind: string;
    try {
      providerKind = resolveProviderKind(capability, providerKindQuery);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    const grant = await runWithOrgScope(options.pool, orgId, (client) =>
      IntegrationConnectionsStore.getControlGrant(client, orgId, providerKind, {
        kind: "operator",
        id: actor.userId,
      }),
    );
    if (grant === undefined) {
      return c.json(
        {
          status: "not_linked",
          capability,
          providerKind,
          message: `link ${providerKind} at the org level first.`,
          linkAffordance: { kind: "org_integration_link", providerKind, orgId },
        },
        200,
      );
    }
    try {
      const provisioner: IntegrationProvisioner = buildIntegrationProvisioner(
        providerKind,
        productionProvisionerDeps(options.secrets),
      );
      const discovered = await provisioner.discover(grant);
      return c.json({ status: "discovered", capability, providerKind, resources: discovered }, 200);
    } catch (error) {
      return c.json({ error: "discover_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
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
