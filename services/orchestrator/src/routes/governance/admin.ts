// gv-14 — governance ADMIN HTTP surface + import facade.
//
// Mounted under createGovernanceRoutes (reachable from main.ts at
// /orgs/:orgId/projects/:projectId/governance). Every operation is org+project
// authz-guarded and org-scoped; writes additionally require org-admin.
//
//   GET  .../governance/revisions   list all policy revisions        (read)
//   GET  .../governance/bindings    list all policy bindings         (read)
//   GET  .../governance/export      the full governance config bundle(read)
//   POST .../governance/import      validate-then-commit a bundle    (admin)
//
// The import endpoint gates fail-closed on the gv-13 analysis BEFORE opening a
// transaction, then commits the whole bundle inside ONE runWithOrgScope
// transaction so any mid-commit failure rolls the entire import back.

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  commitGovernanceImport,
  GovernanceImportBundleSchema,
  preflightGovernanceImport,
  type GovernanceImportRejection,
} from "../../engine/governance/governanceImport.js";
import {
  GovernanceTierAmbiguousNameError,
  GovernanceTierIntegrityError,
  GovernanceTierNotFoundError,
  listGovernanceTiers,
  listPolicyBindings,
} from "../../engine/governance/governanceTierStore.js";
import {
  listPolicyRevisions,
  PolicyContradictionError,
  PolicyRevisionIntegrityError,
  PolicyRevisionNotFoundError,
} from "../../engine/governance/policyRevisionStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface GovernanceAdminRoutesOptions {
  readonly pool: pg.Pool;
}

interface AuthorizedProject {
  readonly actor: ActorContext;
  readonly orgId: string;
  readonly projectId: string;
}

export function createGovernanceAdminRoutes(options: GovernanceAdminRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const base = "/:orgId/projects/:projectId/governance";

  app.get(`${base}/revisions`, async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    const revisions = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
      listPolicyRevisions(client, authorized.orgId, authorized.projectId),
    );
    return c.json({ revisions });
  });

  app.get(`${base}/bindings`, async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    const bindings = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
      listPolicyBindings(client, authorized.orgId, authorized.projectId),
    );
    return c.json({ bindings });
  });

  app.get(`${base}/export`, async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    const bundle = await runWithOrgScope(options.pool, authorized.orgId, async (client) => ({
      tiers: await listGovernanceTiers(client, authorized.orgId, authorized.projectId),
      revisions: await listPolicyRevisions(client, authorized.orgId, authorized.projectId),
      bindings: await listPolicyBindings(client, authorized.orgId, authorized.projectId),
    }));
    return c.json({ export: bundle });
  });

  app.post(`${base}/import`, async (c) => {
    const authorized = await authorizeProject(c, options.pool, true);
    if (isResponse(authorized)) return authorized;
    const parsed = GovernanceImportBundleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_governance_import", issues: parsed.error.issues }, 400);

    const preflight = preflightGovernanceImport(parsed.data);
    if (!preflight.ok) return renderRejection(c, preflight.rejection);

    try {
      const receipt = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        commitGovernanceImport(
          client,
          { orgId: authorized.orgId, projectId: authorized.projectId, createdBy: authorized.actor.userId },
          preflight.bundle,
        ),
      );
      return c.json({ receipt }, 201);
    } catch (error) {
      return handleImportError(c, error);
    }
  });

  return app;
}

function renderRejection(c: Context<ActorContextEnv>, rejection: GovernanceImportRejection): Response {
  if (rejection.kind === "malformed_policy") {
    return c.json(
      { error: "governance_import_malformed_policy", index: rejection.index, issues: rejection.issues },
      400,
    );
  }
  return c.json(
    {
      error: "governance_import_contradictory_policy",
      index: rejection.index,
      contradictionWitnesses: rejection.contradictionWitnesses,
      witnessProofs: rejection.witnessProofs,
      unresolvedReferences: rejection.unresolvedReferences,
    },
    422,
  );
}

function handleImportError(c: Context<ActorContextEnv>, error: unknown): Response {
  if (error instanceof PolicyContradictionError) {
    return c.json({ error: "governance_import_contradictory_policy", contradictionWitnesses: error.witnesses }, 422);
  }
  if (error instanceof GovernanceTierAmbiguousNameError) {
    return c.json({ error: "governance_import_ambiguous_tier", message: error.message }, 409);
  }
  if (error instanceof GovernanceTierNotFoundError) {
    return c.json({ error: "governance_import_tier_not_found", message: error.message }, 404);
  }
  if (error instanceof PolicyRevisionNotFoundError) {
    return c.json({ error: "governance_import_revision_not_found", message: error.message }, 404);
  }
  if (error instanceof GovernanceTierIntegrityError || error instanceof PolicyRevisionIntegrityError) {
    return c.json({ error: "governance_import_integrity_failed", message: error.message }, 409);
  }
  return c.json(
    { error: "governance_import_failed", message: error instanceof Error ? error.message : String(error) },
    500,
  );
}

async function authorizeProject(
  c: Context<ActorContextEnv>,
  pool: pg.Pool,
  write: boolean,
): Promise<AuthorizedProject | Response> {
  const actor = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  if (actor === undefined || orgId === undefined || projectId === undefined) {
    return c.json({ error: "actor_or_scope_missing" }, 500);
  }
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  if (write && !actorIsOrgAdmin(actor, orgId)) return c.json({ error: "governance_admin_required" }, 403);
  try {
    const access = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (access.orgId !== orgId) return c.json({ error: "org_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { actor, orgId, projectId };
}

function isResponse(value: AuthorizedProject | Response): value is Response {
  return value instanceof Response;
}
