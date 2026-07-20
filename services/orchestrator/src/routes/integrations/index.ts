/* eslint-disable import/max-dependencies -- integration HTTP surface wires authority + inventory + provision */
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../../auth/schemas.js";
import type { AuthoringAuthorer } from "../../engine/contracts/authoringKernel.js";
import {
  buildIntegrationProvisioner,
  type IntegrationProvisioner,
} from "../../engine/contracts/integrationProvisioner.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { IntegrationSecretStore } from "../../engine/contracts/integrationSecretStore.js";
import { PgEventStore, type AppendEventInput, type EventStore } from "../../engine/eventStore.js";
import type { EventName } from "../../engine/events/index.js";
import {
  IntegrationFragmentAuthoringFailedError,
  IntegrationFragmentStore,
  resolveIntegrationFragments,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSpec,
} from "../../engine/integrations/fragments/index.js";
import {
  integrationFragmentConfigFromManifest,
  IntegrationsManifestInvalidError,
  resolveIntegrationsManifest,
} from "../../engine/integrations/manifest/index.js";
import { PgIntegrationAuthority } from "../../engine/integrations/integrationAuthorityImpl.js";
import { GenerationAddressedIntegrationSecretStore } from "../../engine/integrations/integrationSecretStoreImpl.js";
import {
  productionProvisionerDeps,
  provisionCapability,
  resolveProviderKind,
  SlackDeliveryAdapterUnavailableError,
} from "../../engine/integrations/provisioningEngine.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import { IntegrationLifecycleInventoryStore } from "../../engine/repositories/integrationLifecycleInventory.js";
import { integrationProjectAccess } from "../../engine/repositories/integrationProjectAccess.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { mountIntegrationAuthorityWrites } from "./authorityWrites.js";
import { mountIntegrationEventsRead } from "./integrationEventsRead.js";

export interface IntegrationRouteDatabase {
  events: EventStore;
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
}

interface SharedRouteOptions {
  secrets: SecretStore;
  integrationSecrets?: IntegrationSecretStore;
  /** Test seam; production omits this and uses the real registry. */
  buildProvisioner?: (kind: string) => IntegrationProvisioner;
  fetchImpl?: typeof fetch;
  /**
   * in-7 — the real F2 writer factory for provider integration definitions. When
   * present, the derive seam authors any MISSING definition fragment (writer→validate,
   * convergent); when absent, a missing fragment halts loud. Production wires the
   * allocating Forge answerer path; only the pool variant supports the derive seam.
   */
  integrationFragmentAuthorer?: (target: {
    orgId: string;
    projectId: string;
  }) => AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft>;
}

export type IntegrationRoutesOptions = SharedRouteOptions &
  ({ pool: pg.Pool; database?: never } | { database: IntegrationRouteDatabase; pool?: never });

const ProvisionMode = z.enum(["greenfield", "brownfield"]);
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

// The derive seam accepts EITHER an already-shaped in-7 fragment `config` (the raw
// IntegrationFragmentConfig) OR the repo-sourced `.tanren/integrations.yml` manifest
// text (`manifestYaml`, in-8). Exactly one — the union of two strict objects rejects
// a body carrying both or neither, and each arm rejects unknown keys.
const DeriveBody = z.union([
  z.object({ config: z.unknown() }).strict(),
  z.object({ manifestYaml: z.string().min(1) }).strict(),
]);

/** EventStore has no ambient scope during an F2 provider (LLM) call; scope each
 * append independently so a long writer call never holds a database transaction
 * open. Mirrors the gv-10 governance route's per-append scoping. */
class OrgScopedEventStore implements Pick<EventStore, "append"> {
  constructor(
    private readonly pool: pg.Pool,
    private readonly orgId: string,
  ) {}

  append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    return runWithOrgScope(this.pool, this.orgId, (client) => new PgEventStore(client).append(input));
  }
}

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

function integrationSecretsFor(options: IntegrationRoutesOptions): IntegrationSecretStore {
  return options.integrationSecrets ?? new GenerationAddressedIntegrationSecretStore(options.secrets);
}

export function createIntegrationRoutes(options: IntegrationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const database = databaseFor(options);
  const integrationSecrets = integrationSecretsFor(options);
  const authority = new PgIntegrationAuthority();
  const fetchImpl = options.fetchImpl ?? fetch;

  app.use("*", async (c, next) => {
    if (c.var.actor === undefined) return c.json({ error: "authentication_required" }, 401);
    return next();
  });

  mountIntegrationEventsRead(app, database);

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
      const rows = await IntegrationConnectionsStore.listInventory(client, orgId, projectId);
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
      providerPrincipalId: row.providerPrincipalId,
      principalKind: row.principalKind,
      displayName: row.displayName,
      health: row.health,
      connectionStatus: row.connectionStatus,
      currentAuthGeneration: row.currentAuthGeneration,
      grantGeneration: row.grantGeneration,
      grantStatus: row.grantStatus,
      authExpiresAt: row.authExpiresAt,
      providerScopes: row.providerScopes,
      pendingOperation: row.pendingOperation,
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
    let providerKind: string;
    try {
      providerKind = resolveProviderKind(parsed.data.capability, parsed.data.providerKind);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    if (providerKind === "slack") {
      return c.json({ error: "slack_bot_delivery_adapter_unavailable" }, 422);
    }
    try {
      const outcome = await provisionCapability(
        {
          database,
          secrets: options.secrets,
          events: database.events,
          actor: { kind: "operator", id: actor.userId },
          authority,
          ...(options.buildProvisioner === undefined ? {} : { buildProvisioner: options.buildProvisioner }),
        },
        { projectId, orgId, ...parsed.data },
      );
      if (outcome.status === "not_linked") return c.json(outcome, 200);
      if (outcome.status === "selection_required") return c.json(outcome, 409);
      if (outcome.status === "ineligible") return c.json(outcome, 409);
      return c.json(outcome, 201);
    } catch (error) {
      if (error instanceof SlackDeliveryAdapterUnavailableError) {
        return c.json({ error: "slack_bot_delivery_adapter_unavailable" }, 422);
      }
      return c.json({ error: "provision_failed" }, 500);
    }
  });

  // in-7 — the integration DERIVATION seam (only on the pool variant: the
  // org-scoped store + per-append event store need a pool).
  if (options.pool !== undefined) {
    mountIntegrationDeriveRoute(app, database, options.pool, options.integrationFragmentAuthorer);
  }

  mountIntegrationAuthorityWrites(app, database, options, authority, integrationSecrets, fetchImpl);

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
    const authorized = await database.withOrgScope(orgId, async (client) => {
      const organization = await client.query("SELECT login FROM organizations WHERE id = $1", [orgId]);
      const orgSlug = (organization.rows[0] as { login?: unknown } | undefined)?.login;
      if (typeof orgSlug !== "string" || orgSlug === "") throw new Error("organization login missing");
      const resolution = await authority.authorizeOperation(client, {
        orgId,
        projectId,
        providerKind,
        capability,
        operation: "discover",
        target: {},
        actor: { kind: "operator", id: actor.userId },
      });
      return { resolution, orgSlug };
    });
    const { resolution } = authorized;
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
    if (resolution.status === "selection_required" || resolution.status === "ineligible") {
      return c.json({ capability, providerKind, ...resolution }, 409);
    }
    try {
      const grant = IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
      const provisioner =
        options.buildProvisioner?.(providerKind) ??
        buildIntegrationProvisioner(providerKind, productionProvisionerDeps(options.secrets));
      const resources = await provisioner.discover(grant, {
        orgId,
        projectId,
        orgSlug: authorized.orgSlug,
        name: projectId,
      });
      return c.json(
        {
          status: "discovered",
          capability,
          providerKind,
          authority: {
            connectionId: grant.connectionId,
            grantId: grant.grantId,
            providerPrincipalId: grant.providerPrincipalId,
            authGeneration: grant.authGeneration,
            grantGeneration: grant.grantGeneration,
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

async function projectAccess(
  database: IntegrationRouteDatabase,
  orgId: string,
  projectId: string,
  actor: ActorContext,
) {
  return database.withOrgScope(orgId, (client) => integrationProjectAccess(client, orgId, projectId, actor));
}

/**
 * in-7 derive seam: resolve the provider-specific integration DEFINITION fragments
 * a project's requirement config needs. A missing definition spawns the F2 authoring
 * DAG (writer→validate, convergent, the shared SP-2 kernel) — emitting
 * `integration.author.*` per attempt — or halts loud
 * (`IntegrationFragmentAuthoringFailedError` → 409). The authorer is the real
 * allocating Forge writer; absent it, a missing definition halts loud.
 */
function mountIntegrationDeriveRoute(
  app: Hono<ActorContextEnv>,
  database: IntegrationRouteDatabase,
  pool: pg.Pool,
  authorerFactory?: (target: {
    orgId: string;
    projectId: string;
  }) => AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft>,
): void {
  app.post("/:orgId/projects/:projectId/integrations/derive", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const access = await projectAccess(database, orgId, projectId, actor);
    if (access === "not_found") return c.json({ error: "project_not_found" }, 404);
    if (access === "denied") return c.json({ error: "project_access_denied" }, 403);

    const parsed = DeriveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_derive", issues: parsed.error.issues }, 400);

    // in-8: a `manifestYaml` body is the repo-sourced `.tanren/integrations.yml`.
    // Parse + validate it fail-closed, then project onto the in-7 fragment config the
    // derive seam already consumes. A malformed manifest is a LOUD 400 — never a
    // silently-ignored / partially-applied / defaulted derive.
    let fragmentConfig: unknown;
    if ("manifestYaml" in parsed.data) {
      try {
        const manifest = resolveIntegrationsManifest(parsed.data.manifestYaml);
        if (manifest === undefined) {
          return c.json({ error: "empty_integrations_manifest" }, 400);
        }
        fragmentConfig = integrationFragmentConfigFromManifest(manifest);
      } catch (error) {
        if (error instanceof IntegrationsManifestInvalidError) {
          return c.json({ error: "invalid_integrations_manifest", issues: error.issues }, 400);
        }
        throw error;
      }
    } else {
      fragmentConfig = parsed.data.config;
    }

    try {
      const composed = await resolveIntegrationFragments({
        config: fragmentConfig,
        context: { orgId, projectId, createdBy: actor.userId },
        ...(authorerFactory === undefined ? {} : { authorer: authorerFactory({ orgId, projectId }) }),
        store: new IntegrationFragmentStore(pool),
        eventStore: new OrgScopedEventStore(pool, orgId),
      });
      return c.json({ ok: true as const, missionNodeId: "in-7" as const, snapshot: composed.snapshot }, 200);
    } catch (error) {
      if (error instanceof IntegrationFragmentAuthoringFailedError) {
        return c.json(
          { error: "integration_fragment_authoring_failed", failedIds: error.failedIds, reasons: error.failureReasons },
          409,
        );
      }
      if (error instanceof z.ZodError) {
        return c.json({ error: "invalid_integration_fragment_config", issues: error.issues }, 400);
      }
      return c.json({ error: "integration_derive_failed", message: messageOf(error) }, 500);
    }
  });
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
