import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { getEffectivePolicySnapshot } from "../../engine/governance/effectivePolicySnapshotStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const SubjectKindSchema = z.enum(["run", "change", "activation"]);

interface AuthorizedProject {
  readonly orgId: string;
  readonly projectId: string;
}

export interface EffectivePolicyRoutesOptions {
  readonly pool: pg.Pool;
}

export function createEffectivePolicyRoutes(options: EffectivePolicyRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/governance/effective/:subjectKind/:subjectId", async (c) =>
    readSnapshot(c, options.pool),
  );
  app.get("/:orgId/projects/:projectId/governance/receipts/:subjectKind/:subjectId", async (c) =>
    readSnapshot(c, options.pool),
  );
  app.get("/:orgId/projects/:projectId/governance/effective", async (c) => readSnapshot(c, options.pool));
  return app;
}

async function readSnapshot(c: Context<ActorContextEnv>, pool: pg.Pool): Promise<Response> {
  const authorized = await authorizeProject(c, pool);
  if (authorized instanceof Response) return authorized;
  const kind = c.req.param("subjectKind") ?? c.req.query("subjectKind");
  const subjectId = c.req.param("subjectId") ?? c.req.query("subjectId");
  const parsedKind = SubjectKindSchema.safeParse(kind);
  if (!parsedKind.success || subjectId === undefined || subjectId.length === 0) {
    return c.json({ error: "invalid_effective_policy_subject" }, 400);
  }
  const snapshot = await runWithOrgScope(pool, authorized.orgId, (client) =>
    getEffectivePolicySnapshot(client, authorized.orgId, authorized.projectId, parsedKind.data, subjectId),
  );
  if (snapshot === undefined) return c.json({ error: "effective_policy_snapshot_not_found" }, 404);
  return c.json({ snapshot });
}

async function authorizeProject(c: Context<ActorContextEnv>, pool: pg.Pool): Promise<AuthorizedProject | Response> {
  const actor: ActorContext | undefined = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  if (actor === undefined || orgId === undefined || projectId === undefined) {
    return c.json({ error: "actor_or_scope_missing" }, 500);
  }
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  try {
    const access = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (access.orgId !== orgId) return c.json({ error: "org_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { orgId, projectId };
}
