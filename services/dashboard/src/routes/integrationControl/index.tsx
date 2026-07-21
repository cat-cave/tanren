// in-21 — Integration Control Center BFF route. Mounts through the shell at
//   GET  /projects/:projectId/integration-control                 — the screen
//   GET  /projects/:projectId/integration-control/schemas.json    — the bundled
//                                                                    JSON-Schema
//                                                                    catalog (a
//                                                                    download).
//
// The screen is project-scoped: it only fires the in-20 reads when the path
// project is visible in the operator's org (same fail-closed gate the other
// project-scoped screens — integration-events, design-studio — enforce). A
// cross-org caller gets ZERO rows through the orchestrator's RLS gate; under
// the BFF that surfaces as the orchestrator returning 403 → the typed client
// returns `{ ok: false, failure: "unavailable", status: 403 }` → the UI
// renders the honest unavailable state. NO panel fabricates success from a
// non-200 / malformed / out-of-scope response.
//
// The schema download serves the bundled TS module generated from
// `contracts/json/integrations/**` (drift-gated by
// `check:integration-schema-bundle-drift`). The download path is project-scoped
// so the route resolves the org+project before serving; a non-visible project
// yields 404 (no bundle is shipped to a caller who cannot scope the project).

import type { Context, Hono } from "hono";
import { IntegrationReadsClient } from "../../api/integrationReadsClient.js";
import {
  INTEGRATION_READ_SCHEMA_CATALOG_VERSION,
  integrationReadSchemaCatalog,
} from "../../api/integrationReadSchemaCatalog.gen.js";
import type {
  CapabilityNodesResponse,
  DeliveryDagStatusResponse,
  IntegrationBindingsResponse,
  IntegrationLifecycleInventoryResponse,
  IntegrationReadResult,
  IntegrationRequirementsResponse,
} from "../../api/integrationReads.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import {
  IntegrationControlBody,
  type IntegrationControlData,
} from "../../components/integrationControl/IntegrationControlBody.js";

function projectParam(c: Context): string {
  const projectId = c.req.param("projectId");
  if (projectId === undefined || projectId === "") throw new Error("projectId route parameter missing");
  return projectId;
}

function visibleOrgId(ctx: ShellContext, projectId: string): string | undefined {
  if (ctx.org === undefined || ctx.project?.projectId !== projectId) return undefined;
  return ctx.org.id;
}

function readClient(c: Context, deps: ShellDeps): IntegrationReadsClient {
  return new IntegrationReadsClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function loadControlData(
  c: Context,
  deps: ShellDeps,
  orgId: string,
  projectId: string,
): Promise<IntegrationControlData> {
  const client = readClient(c, deps);
  // Fire the five independent reads in parallel — the UI panels are independent
  // and a slow/failed endpoint must not block the others.
  const [lifecycle, requirements, capabilityNodes, bindings, delivery] = await Promise.all([
    client.readLifecycle(orgId, projectId),
    client.listRequirements(orgId, projectId),
    client.listCapabilityNodes(orgId, projectId),
    client.listBindings(orgId, projectId),
    client.readDelivery(orgId, projectId),
  ]);
  return { lifecycle, requirements, capabilityNodes, bindings, delivery };
}

/**
 * Render the screen. When the project is not visible in the operator's org
 * (the scope gate fails) the body shows the honest scope-blocked state and NO
 * in-20 read is fired. The data load only happens for a confirmed-visible
 * scope, so an org-scoped cookie cannot bypass the org+project gate.
 */
async function render(c: Context, deps: ShellDeps, ctx: ShellContext, projectId: string): Promise<Response> {
  const orgId = visibleOrgId(ctx, projectId);
  const data: IntegrationControlData =
    orgId === undefined
      ? {
          lifecycle: undefined,
          requirements: undefined,
          capabilityNodes: undefined,
          bindings: undefined,
          delivery: undefined,
        }
      : await loadControlData(c, deps, orgId, projectId);
  return renderShell(
    c,
    ctx,
    { title: "tanren · integration control" },
    <IntegrationControlBody
      projectId={projectId}
      projectName={orgId === undefined ? "" : (ctx.project?.name ?? "")}
      scopeVisible={orgId !== undefined}
      data={data}
    />,
  ) as Promise<Response>;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve the requested schema name from the `?name=` query. Returns the
 * matching catalog entry, or `undefined` to signal "serve the bundled catalog"
 * (no `?name=`), or `null` to signal a name that matches no entry (404).
 */
function resolveSchemaRequest(
  name: string | undefined,
):
  | { readonly kind: "bundle" }
  | { readonly kind: "single"; readonly entry: (typeof integrationReadSchemaCatalog)[number] }
  | { readonly kind: "not_found" } {
  if (name === undefined || name === "") return { kind: "bundle" };
  const entry = integrationReadSchemaCatalog.find((candidate) => candidate.name === name);
  if (entry === undefined) return { kind: "not_found" };
  return { kind: "single", entry };
}

/** The schema download endpoint. Serves one entry or the bundled catalog. */
async function serveSchemaCatalog(
  c: Context,
  _deps: ShellDeps,
  ctx: ShellContext,
  projectId: string,
): Promise<Response> {
  // The download path is project-scoped; a non-visible project gets 404 (no
  // bundle ships to a caller who cannot scope the project).
  if (visibleOrgId(ctx, projectId) === undefined) {
    return c.json({ error: "project_scope_required" }, 404);
  }
  const requested = resolveSchemaRequest(isNonEmpty(c.req.query("name")) ? c.req.query("name") : undefined);
  if (requested.kind === "not_found") {
    return c.json({ error: "schema_not_found", name: c.req.query("name") }, 404);
  }
  if (requested.kind === "single") {
    c.header("content-type", "application/schema+json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${requested.entry.name}.json"`);
    return c.body(requested.entry.json);
  }
  // Bundled catalog: emit one JSON document with the version tag + each entry's
  // parsed JSON body (so a downstream tool reads structured JSON, not strings).
  const bundled = {
    version: INTEGRATION_READ_SCHEMA_CATALOG_VERSION,
    schemas: integrationReadSchemaCatalog.map((entry) => ({
      name: entry.name,
      schemaId: entry.schemaId,
      schema: JSON.parse(entry.json) as unknown,
    })),
  };
  c.header("content-type", "application/json; charset=utf-8");
  c.header("content-disposition", 'attachment; filename="integration-read-schema-catalog.json"');
  return c.json(bundled);
}

/** Mount the in-21 Integration Control Center. */
export function mountIntegrationControlScreen(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/integration-control", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations", projectId });
    return render(c, deps, ctx, projectId);
  });

  app.get("/projects/:projectId/integration-control/schemas.json", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations", projectId });
    return serveSchemaCatalog(c, deps, ctx, projectId);
  });
}

/** Re-exported for tests so the wrapper type stays closed across the BFF boundary. */
export type {
  IntegrationReadResult,
  IntegrationLifecycleInventoryResponse,
  IntegrationRequirementsResponse,
  CapabilityNodesResponse,
  IntegrationBindingsResponse,
  DeliveryDagStatusResponse,
};
