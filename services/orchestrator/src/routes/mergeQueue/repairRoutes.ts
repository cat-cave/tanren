// mq-10 read-only projection over `merge_repair_routes` — the autonomous-repair + respec
// lineage the mergequeue spec exposes on the entry-detail surface. Org-membership + project
// authorization, RLS-scoped; a cross-org read is an indistinguishable 404.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const RepairRouteProjection = z
  .object({
    routeId: z.string().min(1),
    sourceSpecId: z.string().min(1),
    groupId: z.string().min(1),
    evaluationId: z.string().min(1),
    disposition: z.enum(["repair_in_place", "respec", "blocked_needs_attention"]),
    failureClass: z.string().min(1),
    failureSignature: z.string().min(1),
    magnitude: z.number().int().nonnegative(),
    findingIds: z.array(z.string()),
    reasonCodes: z.array(z.string()),
    respecGeneration: z.number().int().nonnegative(),
    priorAgentRoute: z.string().min(1).nullable(),
    nextAgentRoute: z.string().min(1).nullable(),
    packetHash: z.string().min(1).nullable(),
    replacementSpecIds: z.array(z.string()),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
type RepairRouteProjection = z.infer<typeof RepairRouteProjection>;

const ListResponse = z.object({ repairRoutes: z.array(RepairRouteProjection) }).strict();

interface RepairRouteRow {
  route_id: string;
  source_spec_id: string;
  group_id: string;
  evaluation_id: string;
  disposition: "repair_in_place" | "respec" | "blocked_needs_attention";
  failure_class: string;
  failure_signature: string;
  magnitude: number;
  finding_ids: string[];
  reason_codes: string[];
  respec_generation: number;
  prior_agent_route: string | null;
  next_agent_route: string | null;
  packet_hash: string | null;
  replacement_spec_ids: string[];
  created_at: Date | string;
}

interface RepairRouteRoutesOptions {
  pool: pg.Pool;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function project(row: RepairRouteRow): RepairRouteProjection {
  return RepairRouteProjection.parse({
    routeId: row.route_id,
    sourceSpecId: row.source_spec_id,
    groupId: row.group_id,
    evaluationId: row.evaluation_id,
    disposition: row.disposition,
    failureClass: row.failure_class,
    failureSignature: row.failure_signature,
    magnitude: row.magnitude,
    findingIds: row.finding_ids,
    reasonCodes: row.reason_codes,
    respecGeneration: row.respec_generation,
    priorAgentRoute: row.prior_agent_route,
    nextAgentRoute: row.next_agent_route,
    packetHash: row.packet_hash,
    replacementSpecIds: row.replacement_spec_ids,
    observedAt: iso(row.created_at),
  });
}

async function readRepairRoutes(input: {
  pool: pg.Pool;
  actor: ActorContext;
  orgId: string;
  projectId: string;
  specId?: string;
  limit: number;
}): Promise<RepairRouteProjection[] | null> {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project0 = await assertProjectAccess(client, input.projectId, input.actor);
      if (project0.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }
    const filterSpec = input.specId !== undefined;
    const rows = await client.query<RepairRouteRow>(
      `SELECT route_id, source_spec_id, group_id, evaluation_id, disposition, failure_class,
              failure_signature, magnitude, finding_ids, reason_codes, respec_generation,
              prior_agent_route, next_agent_route, packet_hash, replacement_spec_ids, created_at
         FROM merge_repair_routes
        WHERE org_id = $1 AND project_id = $2 ${filterSpec ? "AND source_spec_id = $4" : ""}
        ORDER BY created_at DESC, route_id DESC
        LIMIT $3`,
      filterSpec
        ? [input.orgId, input.projectId, input.limit, input.specId]
        : [input.orgId, input.projectId, input.limit],
    );
    return rows.rows.map(project);
  });
}

export function createMergeQueueRepairRouteRoutes(options: RepairRouteRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/merge-queue/repair-routes", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_queue_repair_routes_not_found" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === undefined) return c.json({ error: "invalid_limit", min: 1, max: MAX_LIMIT }, 400);
    const specId = c.req.query("specId");
    const repairRoutes = await readRepairRoutes({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      limit,
      ...(specId !== undefined && specId !== "" && { specId }),
    });
    if (repairRoutes === null) return c.json({ error: "merge_queue_repair_routes_not_found" }, 404);
    return c.json(ListResponse.parse({ repairRoutes }));
  });
  return app;
}
