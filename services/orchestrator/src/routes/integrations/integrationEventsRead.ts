import type { Hono } from "hono";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { EventRegistry, isEventName } from "../../engine/events/index.js";
import { redactEventPayload } from "../../engine/redaction/index.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import { integrationProjectAccess } from "../../engine/repositories/integrationProjectAccess.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface IntegrationEventsReadDatabase {
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
}

const RawIntegrationEvent = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u)]),
    ts: z.coerce.date(),
    project_id: z.string().min(1),
    event_type: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface IntegrationEventRead {
  id: string;
  ts: string;
  projectId: string;
  eventType: string;
  payload: unknown;
  redactedPaths: string[];
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function decodeIntegrationEvent(row: unknown, actor: ActorContext): IntegrationEventRead {
  const parsed = RawIntegrationEvent.parse(row);
  if (!isEventName(parsed.event_type)) {
    throw new Error(`integration event '${parsed.event_type}' is not registered`);
  }
  const payload = EventRegistry[parsed.event_type].parse(parsed.payload);
  const redacted = redactEventPayload({
    eventName: parsed.event_type,
    payload,
    actor,
  });
  return {
    id: String(parsed.id),
    ts: parsed.ts.toISOString(),
    projectId: parsed.project_id,
    eventType: parsed.event_type,
    payload: redacted.payload,
    redactedPaths: redacted.redactedPaths,
  };
}

/** Mount the org/project-scoped integration event read surface. */
export function mountIntegrationEventsRead(app: Hono<ActorContextEnv>, database: IntegrationEventsReadDatabase): void {
  app.get("/:orgId/projects/:projectId/integration-events", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);

    const limit = parseLimit(c.req.query("limit"));
    try {
      const result = await database.withOrgScope(orgId, async (client) => {
        const access = await integrationProjectAccess(client, orgId, projectId, actor);
        if (access !== "allowed") return { access } as const;
        const rows = await client.query(
          `SELECT id, ts, project_id, event_type, payload
             FROM events
            WHERE org_id = $1
              AND project_id = $2
              AND event_type LIKE 'integration.%'
            ORDER BY ts DESC, id DESC
            LIMIT $3`,
          [orgId, projectId, limit],
        );
        return {
          access: "allowed" as const,
          events: rows.rows.map((row) => decodeIntegrationEvent(row, actor)),
        };
      });
      if (result.access !== "allowed") {
        return result.access === "not_found"
          ? c.json({ error: "project_not_found" }, 404)
          : c.json({ error: "project_access_denied" }, 403);
      }
      return c.json({ projectId, events: result.events }, 200);
    } catch (error) {
      return c.json(
        {
          error: "integration_events_read_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}
