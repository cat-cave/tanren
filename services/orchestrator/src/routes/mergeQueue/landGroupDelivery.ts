// mq-13 read-only land-group DELIVERY route. One org-scoped GET over the durable
// `land_group_delivery_loops` table — the group delivery timeline (artifact, preview /
// production / rollback release lineage, terminal disposition, receipt id) for one land group.
// It runs through `runWithOrgScope` + `assertProjectAccess`; a cross-org / cross-project caller
// sees ZERO rows (RLS) and a 404 — never another org's delivery. A row with a corrupt receipt
// surfaces the summary but a null receipt (never a fabricated green).

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  PgLandGroupDeliveryStore,
  type LandGroupDeliverySummary,
} from "../../engine/postMerge/landGroupDelivery/landGroupDeliveryStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface LandGroupDeliveryRoutesOptions {
  pool: pg.Pool;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

/** Run `read` under org scope only after project access is confirmed; null ⇒ 404. */
async function withProject<T>(input: {
  pool: pg.Pool;
  actor: ActorContext;
  orgId: string;
  projectId: string;
  read: (client: pg.PoolClient) => Promise<T>;
}): Promise<T | null> {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, input.projectId, input.actor);
      if (project.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }
    return input.read(client);
  });
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : undefined;
}

export function createLandGroupDeliveryRoutes(options: LandGroupDeliveryRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  // The project's land-group deliveries, newest first — the panel's timeline list.
  app.get("/:orgId/projects/:projectId/merge-queue/land-group-deliveries", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "land_group_delivery_not_found" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === undefined) return c.json({ error: "invalid_limit", min: 1, max: MAX_LIMIT }, 400);
    const projectId = c.req.param("projectId");
    const deliveries = await withProject({
      pool: options.pool,
      actor,
      orgId,
      projectId,
      read: (client): Promise<LandGroupDeliverySummary[]> =>
        PgLandGroupDeliveryStore.list(client, orgId, projectId, limit),
    });
    if (deliveries === null) return c.json({ error: "land_group_delivery_not_found" }, 404);
    return c.json({ deliveries });
  });

  app.get("/:orgId/projects/:projectId/merge-queue/land-groups/:landGroupId/delivery", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "land_group_delivery_not_found" }, 404);
    const projectId = c.req.param("projectId");
    const landGroupId = c.req.param("landGroupId");
    const delivery = await withProject({
      pool: options.pool,
      actor,
      orgId,
      projectId,
      read: (client): Promise<LandGroupDeliverySummary | undefined> =>
        PgLandGroupDeliveryStore.getByLandGroup(client, orgId, projectId, landGroupId),
    });
    if (delivery === null || delivery === undefined) return c.json({ error: "land_group_delivery_not_found" }, 404);
    return c.json({ delivery });
  });

  return app;
}
