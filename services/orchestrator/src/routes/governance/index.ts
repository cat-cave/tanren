import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  activatePolicyRevision,
  compilePolicyRevision,
  createPolicyRevision,
  getPolicyRevision,
  PolicyContradictionError,
  PolicyRevisionIntegrityError,
  PolicyRevisionNotFoundError,
  validatePolicyRevision,
} from "../../engine/governance/policyRevisionStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import { createGovernanceTierRoutes } from "./tiers.js";

const CreateRevisionBodySchema = z
  .object({
    sourceDocument: z.unknown(),
    parentRevisionId: z.string().min(1).max(256).optional(),
  })
  .strict();

const ValidateRevisionBodySchema = z
  .object({
    sourceDocument: z.unknown(),
  })
  .strict();

export interface GovernanceRoutesOptions {
  readonly pool: pg.Pool;
}

interface AuthorizedProject {
  readonly actor: ActorContext;
  readonly orgId: string;
  readonly projectId: string;
}

export function createGovernanceRoutes(options: GovernanceRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.route("/", createGovernanceTierRoutes(options));

  app.post("/:orgId/projects/:projectId/governance/revisions", async (c) => {
    const authorized = await authorizeProject(c, options.pool, true);
    if (isResponse(authorized)) return authorized;
    const parsed = CreateRevisionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, parsed.error);
    try {
      const revision = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        createPolicyRevision(client, {
          orgId: authorized.orgId,
          projectId: authorized.projectId,
          sourceDocument: parsed.data.sourceDocument,
          ...(parsed.data.parentRevisionId === undefined ? {} : { parentRevisionId: parsed.data.parentRevisionId }),
          createdBy: authorized.actor.userId,
        }),
      );
      return c.json({ revision }, 201);
    } catch (error) {
      return handlePolicyError(c, error, "governance_policy_create_failed");
    }
  });

  app.post("/:orgId/projects/:projectId/governance/revisions/validate", async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    const parsed = ValidateRevisionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, parsed.error);
    return validateDocument(c, parsed.data.sourceDocument);
  });

  app.get("/:orgId/projects/:projectId/governance/revisions/:revision", async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    try {
      const revision = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        getPolicyRevision(client, authorized.orgId, authorized.projectId, c.req.param("revision")),
      );
      return c.json({ revision });
    } catch (error) {
      return handlePolicyError(c, error, "governance_policy_read_failed");
    }
  });

  app.post("/:orgId/projects/:projectId/governance/revisions/:revision/validate", async (c) => {
    const authorized = await authorizeProject(c, options.pool, false);
    if (isResponse(authorized)) return authorized;
    try {
      const revision = await readRevision(options.pool, authorized, c.req.param("revision"));
      return validateDocument(c, revision.sourceDocument);
    } catch (error) {
      return handlePolicyError(c, error, "governance_policy_validate_failed");
    }
  });

  app.post("/:orgId/projects/:projectId/governance/revisions/:revision/compile", async (c) => {
    const authorized = await authorizeProject(c, options.pool, true);
    if (isResponse(authorized)) return authorized;
    try {
      const revision = await readRevision(options.pool, authorized, c.req.param("revision"));
      const compiled = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        compilePolicyRevision(client, authorized.orgId, revision),
      );
      return c.json({ revision: compiled });
    } catch (error) {
      return handlePolicyError(c, error, "governance_policy_compile_failed");
    }
  });

  app.post("/:orgId/projects/:projectId/governance/revisions/:revision/activate", async (c) => {
    const authorized = await authorizeProject(c, options.pool, true);
    if (isResponse(authorized)) return authorized;
    try {
      const revision = await readRevision(options.pool, authorized, c.req.param("revision"));
      const activated = await runWithOrgScope(options.pool, authorized.orgId, (client) =>
        activatePolicyRevision(client, authorized.orgId, revision),
      );
      return c.json({ revision: activated });
    } catch (error) {
      return handlePolicyError(c, error, "governance_policy_activate_failed");
    }
  });

  return app;
}

async function readRevision(pool: pg.Pool, authorized: AuthorizedProject, revision: string) {
  return runWithOrgScope(pool, authorized.orgId, (client) =>
    getPolicyRevision(client, authorized.orgId, authorized.projectId, revision),
  );
}

async function validateDocument(c: Context<ActorContextEnv>, sourceDocument: unknown): Promise<Response> {
  try {
    const result = await validatePolicyRevision(sourceDocument);
    return c.json({ ok: true, policyHash: result.policyHash, compiledAst: result.ast, ruleCount: result.ruleCount });
  } catch (error) {
    if (error instanceof PolicyContradictionError) {
      return c.json({ ok: false, contradictionWitnesses: error.witnesses }, 422);
    }
    return handlePolicyError(c, error, "governance_policy_validate_failed");
  }
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
  if (write && !actorIsOrgAdmin(actor, orgId)) {
    return c.json({ error: "governance_admin_required" }, 403);
  }
  try {
    const access = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (access.orgId !== orgId) return c.json({ error: "org_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return c.json({ error: "project_access_denied" }, 403);
    }
    throw error;
  }
  return { actor, orgId, projectId };
}

function isResponse(value: AuthorizedProject | Response): value is Response {
  return value instanceof Response;
}

function invalidBody(c: Context<ActorContextEnv>, error: z.ZodError): Response {
  return c.json({ error: "invalid_governance_policy", issues: error.issues }, 400);
}

function handlePolicyError(c: Context<ActorContextEnv>, error: unknown, fallback: string): Response {
  if (error instanceof PolicyContradictionError) {
    return c.json({ error: "policy_contradictory", contradictionWitnesses: error.witnesses }, 422);
  }
  if (error instanceof PolicyRevisionNotFoundError) return c.json({ error: "policy_revision_not_found" }, 404);
  if (error instanceof PolicyRevisionIntegrityError) return c.json({ error: "policy_revision_integrity_failed" }, 409);
  return c.json({ error: fallback, message: error instanceof Error ? error.message : String(error) }, 500);
}
