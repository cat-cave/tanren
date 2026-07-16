import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  MergeQueueAuthorityEvaluationResponse,
  MergeQueueAuthoritySignalProjection,
  MergeQueueAuthoritySignalsListResponse,
  type MergeQueueAuthoritySignalProjection as AuthoritySignalProjection,
} from "../../engine/events/schemas/mergeQueueAuthoritySignals.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface MergeQueueAuthoritySignalRoutesOptions {
  readonly pool: pg.Pool;
}

interface SignalRow {
  readonly event_id: string;
  readonly ts: Date | string;
  readonly payload: unknown;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_LIMIT ? parsed : undefined;
}

function projectNotFound(c: { json: (body: { error: string }, status: 404) => Response }): Response {
  return c.json({ error: "merge_queue_signals_not_found" }, 404);
}

function evaluationNotFound(c: { json: (body: { error: string }, status: 404) => Response }): Response {
  return c.json({ error: "merge_queue_evaluation_not_found" }, 404);
}

function projectIsVisible(actor: ActorContext, orgId: string): boolean {
  return actorCanAccessOrg(actor, orgId);
}

async function readAuthorizedRows(input: {
  readonly pool: pg.Pool;
  readonly actor: ActorContext;
  readonly orgId: string;
  readonly projectId: string;
  readonly evaluationId?: string;
  readonly limit?: number;
}): Promise<SignalRow[] | null> {
  return await runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, input.projectId, input.actor);
      if (project.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }

    if (input.evaluationId !== undefined) {
      const result = await client.query<SignalRow>(
        `SELECT id::text AS event_id, ts, payload
           FROM events
          WHERE project_id = $1
            AND org_id = $2
            AND event_type = 'merge.signal.classified'
            AND payload->>'evaluationId' = $3
          ORDER BY id ASC`,
        [input.projectId, input.orgId, input.evaluationId],
      );
      return result.rows;
    }

    const result = await client.query<SignalRow>(
      `SELECT id::text AS event_id, ts, payload
         FROM events
        WHERE project_id = $1
          AND org_id = $2
          AND event_type = 'merge.signal.classified'
        ORDER BY id DESC
        LIMIT $3`,
      [input.projectId, input.orgId, input.limit ?? DEFAULT_LIMIT],
    );
    return result.rows;
  });
}

function projectRows(rows: ReadonlyArray<SignalRow>): AuthoritySignalProjection[] {
  return rows.map((row) =>
    MergeQueueAuthoritySignalProjection.parse({
      eventId: row.event_id,
      observedAt: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
      signal: row.payload,
    }),
  );
}

/**
 * Read-only mq-1 projection. The collection endpoint is the discoverability
 * surface: operators never need to invent or paste an evaluation identity.
 */
export function createMergeQueueAuthoritySignalRoutes(options: MergeQueueAuthoritySignalRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/merge-queue/authority-signals", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!projectIsVisible(actor, orgId)) return projectNotFound(c);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === undefined) return c.json({ error: "invalid_limit", min: 1, max: MAX_LIMIT }, 400);

    const rows = await readAuthorizedRows({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      limit,
    });
    if (rows === null) return projectNotFound(c);
    const signals = projectRows(rows);
    return c.json(
      MergeQueueAuthoritySignalsListResponse.parse({
        latestEvaluationId: signals[0]?.signal.evaluationId ?? null,
        signals,
      }),
    );
  });

  app.get("/:orgId/projects/:projectId/merge-queue/evaluations/:evaluationId/signals", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!projectIsVisible(actor, orgId)) return evaluationNotFound(c);
    const evaluationId = c.req.param("evaluationId");
    const rows = await readAuthorizedRows({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      evaluationId,
    });
    if (rows === null || rows.length === 0) return evaluationNotFound(c);
    return c.json(MergeQueueAuthorityEvaluationResponse.parse({ evaluationId, signals: projectRows(rows) }));
  });

  return app;
}
