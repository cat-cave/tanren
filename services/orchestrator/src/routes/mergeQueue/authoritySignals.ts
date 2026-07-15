import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { MergeSignalClassifiedPayload } from "../../engine/events/schemas/mergeQueueAuthoritySignals.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface MergeQueueAuthoritySignalRoutesOptions {
  pool: pg.Pool;
}

interface SignalRow {
  event_id: string;
  ts: Date | string;
  payload: unknown;
}

export interface MergeQueueAuthoritySignalProjection {
  eventId: string;
  observedAt: string;
  signal: ReturnType<typeof MergeSignalClassifiedPayload.parse>;
}

/**
 * Read the durable mq-1 projection. Missing, inaccessible, and cross-org
 * evaluations deliberately share one 404 shape so the endpoint leaks no
 * project or evaluation identity.
 */
export function createMergeQueueAuthoritySignalRoutes(options: MergeQueueAuthoritySignalRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/merge-queue/evaluations/:evaluationId/signals", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
    }

    const projectId = c.req.param("projectId");
    const evaluationId = c.req.param("evaluationId");
    const rows = await runWithOrgScope(options.pool, orgId, async (client) => {
      try {
        const project = await assertProjectAccess(client, projectId, actor);
        if (project.orgId !== orgId) return null;
      } catch (error) {
        if (error instanceof ToolAccessDeniedError) return null;
        throw error;
      }

      return await client.query<SignalRow>(
        `SELECT id::text AS event_id, ts, payload
           FROM events
          WHERE project_id = $1
            AND org_id = $2
            AND event_type = 'merge.signal.classified'
            AND payload->>'evaluationId' = $3
          ORDER BY id ASC`,
        [projectId, orgId, evaluationId],
      );
    });

    if (rows === null || rows.rowCount === 0) {
      return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
    }

    const signals: MergeQueueAuthoritySignalProjection[] = rows.rows.map((row) => ({
      eventId: row.event_id,
      observedAt: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
      signal: MergeSignalClassifiedPayload.parse(row.payload),
    }));
    return c.json({ evaluationId, signals });
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
