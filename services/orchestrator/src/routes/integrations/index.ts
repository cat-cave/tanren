import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../../auth/schemas.js";
import {
  buildIntegrationProvisioner,
  type IntegrationProvisioner,
} from "../../engine/contracts/integrationProvisioner.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { EventStore } from "../../engine/eventStore.js";
import { PgEventStore } from "../../engine/eventStore.js";
import {
  capabilitiesForProviderKind,
  productionProvisionerDeps,
  provisionCapability,
  resolveProviderKind,
} from "../../engine/integrations/provisioningEngine.js";
import {
  credentialRefForIntegrationAccount,
  IntegrationConnectionsStore,
} from "../../engine/repositories/integrationConnections.js";
import { IntegrationLifecycleInventoryStore } from "../../engine/repositories/integrationLifecycleInventory.js";
import { integrationProjectAccess } from "../../engine/repositories/integrationProjectAccess.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface IntegrationRouteDatabase {
  events: EventStore;
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
}

interface SharedRouteOptions {
  secrets: SecretStore;
  /** Test seam; production omits this and uses the real registry. */
  buildProvisioner?: (kind: string) => IntegrationProvisioner;
}

export type IntegrationRoutesOptions = SharedRouteOptions &
  ({ pool: pg.Pool; database?: never } | { database: IntegrationRouteDatabase; pool?: never });

const ProvisionMode = z.enum(["greenfield", "brownfield"]);
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
const SelectionBody = z
  .object({ connectionId: z.string().min(1).max(200), grantId: z.string().min(1).max(200) })
  .strict();

function databaseFor(options: IntegrationRoutesOptions): IntegrationRouteDatabase {
  if (options.database !== undefined) return options.database;
  const pool = options.pool;
  return {
    events: new PgEventStore(pool),
    withOrgScope: (orgId, work) =>
      runWithOrgScope(pool, orgId, (client) =>
        work({
          async query(sql, params) {
            const result = await client.query(sql, params);
            return { rows: result.rows, rowCount: result.rowCount };
          },
        }),
      ),
  };
}

export function createIntegrationRoutes(options: IntegrationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const database = databaseFor(options);

  // Keep this surface safe even when mounted without the global auth middleware.
  app.use("*", async (c, next) => {
    if (c.var.actor === undefined) return c.json({ error: "authentication_required" }, 401);
    return next();
  });

  app.get("/:orgId/integrations", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const projectId = c.req.query("projectId");

    const loaded = await database.withOrgScope(orgId, async (client) => {
      if (projectId !== undefined && projectId !== "") {
        const access = await integrationProjectAccess(client, orgId, projectId, actor);
        if (access !== "allowed") return { access } as const;
      }
      const operator = { kind: "operator" as const, id: actor.userId };
      const rows = await IntegrationConnectionsStore.listControlGrants(client, orgId, operator, projectId);
      const lifecycle =
        projectId === undefined || projectId === ""
          ? undefined
          : await IntegrationLifecycleInventoryStore.getForProject(client, orgId, projectId, operator);
      return { access: "allowed" as const, rows, lifecycle };
    });
    if (loaded.access !== "allowed") {
      return loaded.access === "not_found"
        ? c.json({ error: "project_not_found" }, 404)
        : c.json({ error: "project_access_denied" }, 403);
    }

    const integrations = loaded.rows.map((row) => ({
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
      selectedForProject: row.selectedForProject,
    }));
    return c.json({ integrations, ...(loaded.lifecycle === undefined ? {} : { lifecycle: loaded.lifecycle }) }, 200);
  });

  app.post("/:orgId/projects/:projectId/integrations/provision", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const access = await projectAccess(database, orgId, projectId, actor);
    if (access === "not_found") return c.json({ error: "project_not_found" }, 404);
    if (access === "denied") return c.json({ error: "project_access_denied" }, 403);

    const parsed = ProvisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_provision", issues: parsed.error.issues }, 400);
    try {
      resolveProviderKind(parsed.data.capability, parsed.data.providerKind);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    try {
      const outcome = await provisionCapability(
        {
          database,
          secrets: options.secrets,
          events: database.events,
          actor: { kind: "operator", id: actor.userId },
          ...(options.buildProvisioner === undefined ? {} : { buildProvisioner: options.buildProvisioner }),
        },
        { projectId, orgId, ...parsed.data },
      );
      if (outcome.status === "not_linked") return c.json(outcome, 200);
      if (outcome.status === "selection_required") return c.json(outcome, 409);
      return c.json(outcome, 201);
    } catch {
      return c.json({ error: "provision_failed" }, 500);
    }
  });

  mountIntegrationAuthorityWrites(app, database, options);

  app.get("/:orgId/projects/:projectId/integrations/discover", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const access = await projectAccess(database, orgId, projectId, actor);
    if (access === "not_found") return c.json({ error: "project_not_found" }, 404);
    if (access === "denied") return c.json({ error: "project_access_denied" }, 403);

    const capability = c.req.query("capability") ?? "";
    let providerKind: string;
    try {
      providerKind = resolveProviderKind(capability, c.req.query("providerKind"));
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    const resolution = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.resolveControlGrant(client, orgId, projectId, providerKind, {
        kind: "operator",
        id: actor.userId,
      }),
    );
    if (resolution.status === "not_linked") {
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
    if (resolution.status === "selection_required") {
      return c.json({ capability, providerKind, ...resolution }, 409);
    }
    try {
      const provisioner =
        options.buildProvisioner?.(providerKind) ??
        buildIntegrationProvisioner(providerKind, productionProvisionerDeps(options.secrets));
      const resources = await provisioner.discover(resolution.grant);
      return c.json(
        {
          status: "discovered",
          capability,
          providerKind,
          authority: {
            connectionId: resolution.grant.connectionId,
            grantId: resolution.grant.grantId,
            upstreamAccountId: resolution.grant.upstreamAccountId,
            authGeneration: resolution.grant.authGeneration,
            grantGeneration: resolution.grant.grantGeneration,
          },
          resources,
        },
        200,
      );
    } catch {
      return c.json({ error: "discover_failed" }, 500);
    }
  });

  return app;
}

function mountIntegrationAuthorityWrites(
  app: Hono<ActorContextEnv>,
  database: IntegrationRouteDatabase,
  options: IntegrationRoutesOptions,
): void {
  app.post("/:orgId/integrations/:providerKind", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const providerKind = c.req.param("providerKind");
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    let capabilities: string[];
    try {
      capabilities = capabilitiesForProviderKind(providerKind);
    } catch (error) {
      return c.json({ error: "unknown_provider_kind", message: messageOf(error) }, 400);
    }
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_link", issues: parsed.error.issues }, 400);

    const credentialRef = credentialRefForIntegrationAccount(orgId, providerKind, parsed.data.upstreamAccountId);
    try {
      await options.secrets.put({ ref: credentialRef, value: parsed.data.token });
      const grant = await database.withOrgScope(orgId, (client) =>
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
      return c.json(
        {
          status: "linked",
          providerKind,
          connectionId: grant.connectionId,
          grantId: grant.grantId,
          upstreamAccountId: grant.upstreamAccountId,
          authGeneration: grant.authGeneration,
          grantGeneration: grant.grantGeneration,
          capabilities,
          metadataKeys: Object.keys(grant.metadata),
        },
        201,
      );
    } catch {
      return c.json({ error: "link_failed" }, 500);
    }
  });

  app.put("/:orgId/projects/:projectId/integrations/:providerKind/selection", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const providerKind = c.req.param("providerKind");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const access = await projectAccess(database, orgId, projectId, actor);
    if (access === "not_found") return c.json({ error: "project_not_found" }, 404);
    if (access === "denied") return c.json({ error: "project_access_denied" }, 403);
    const parsed = SelectionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_selection", issues: parsed.error.issues }, 400);

    const selected = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        { orgId, projectId, providerKind, ...parsed.data },
        { kind: "operator", id: actor.userId },
      ),
    );
    if (selected === undefined) return c.json({ error: "selection_conflict" }, 409);
    return c.json(
      {
        status: "selected",
        providerKind,
        connectionId: selected.connectionId,
        grantId: selected.grantId,
        upstreamAccountId: selected.upstreamAccountId,
        authGeneration: selected.authGeneration,
        grantGeneration: selected.grantGeneration,
      },
      200,
    );
  });
}

async function projectAccess(
  database: IntegrationRouteDatabase,
  orgId: string,
  projectId: string,
  actor: ActorContext,
) {
  return database.withOrgScope(orgId, (client) => integrationProjectAccess(client, orgId, projectId, actor));
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
