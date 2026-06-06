// GET /orgs/:orgId/projects/:projectId/progress — the single "where is my
// project" aggregate. Mirrors the spec/run/feed authz (requireActor +
// actorCanAccessOrg + the project-access gate) and reuses their org-scoped
// reads verbatim: the spec list (`projectSpecs.listForProject`), the project
// run list (`fetchRunListItems`), and the activity feed (`fetchFeedPage`). The
// fold into the aggregate lives in `buildProjectProgress` (pure, no I/O). A
// read-only mirror of the dashboard — no writes, no side effects, no secrets
// (the feed is loaded WITHOUT raw-view, so payloads stay redacted).
//
// Extracted from routes/runs/index.ts so that file stays under its line +
// dependency caps: the progress surface carries its own repository/read imports.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { pgRepositories, type QueryClient } from "../../engine/contracts/repositories.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { fetchFeedPage, fetchRunListItems } from "./list.js";
import { buildProjectProgress, RECENT_MILESTONE_CAP } from "./progress.js";

export function registerProjectProgressRoute(app: Hono<ActorContextEnv>, options: { pool: pg.Pool }): void {
  app.get("/:orgId/projects/:projectId/progress", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    // One org-scoped transaction for all progress reads (same scope discipline the
    // sibling routes use). The feed stays a bounded recent window for
    // milestones/stages/lastActivityAt; completion blockers come from the
    // unbounded merge-signal projection below so an old terminal halt still
    // prevents false v1 completion.
    const { project, specs, runs, feed, completionBlockingSpecIds } = await runWithOrgScope(
      options.pool,
      orgId,
      async (client) => {
        const projectRow = await ProjectStore.get(client, projectId, systemActor);
        const specRows = await pgRepositories.projectSpecs.listForProject(client, projectId, systemActor);
        const runItems = await fetchRunListItems(client, { projectId, orgId, status: undefined, specId: undefined });
        const blockers = await fetchCompletionBlockingSpecIds(client, { projectId, orgId });
        const feedPage = await fetchFeedPage(client, {
          projectId,
          orgId,
          cursor: undefined,
          // A milestone is a fraction of the feed; pull a generous window so the
          // top ~20 milestones are present even when interleaved with noise.
          pageSize: String(RECENT_MILESTONE_CAP * 10),
          actor,
          // Redacted view ONLY — the progress surface never opts into raw values.
          rawView: false,
        });
        return {
          project: projectRow,
          specs: specRows,
          runs: runItems,
          feed: feedPage.items,
          completionBlockingSpecIds: blockers,
        };
      },
    );

    // The project-access gate above already authorized the actor against the
    // project; this is the same defense-in-depth tenant check the project-read
    // route applies (a non-null org_id must match the path org).
    if (project === undefined) {
      return c.json({ error: "project_not_found" }, 404);
    }
    if (project.orgId !== null && project.orgId !== undefined && project.orgId !== orgId) {
      return c.json({ error: "project_not_found" }, 404);
    }
    const progress = buildProjectProgress({
      project: { id: project.projectId, name: project.name, repoUrl: project.repoUrl },
      specs,
      runs,
      feed,
      completionBlockingSpecIds,
    });
    return c.json(progress);
  });
}

async function fetchCompletionBlockingSpecIds(
  client: QueryClient,
  args: { projectId: string; orgId: string },
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ spec_id: string }>(
    `WITH signal_events AS (
       SELECT id, ts, event_type, spec_id, run_id, payload
         FROM events
        WHERE project_id = $1
          AND org_id = $2
          AND (
            event_type = 'merge.completed'
            OR (
              event_type = 'merge.queue.infra_blocked'
              AND (NOT (payload ? 'integration') OR payload ->> 'integration' = 'native_queue')
            )
            OR (
              event_type = 'merge.batch.infra_blocked'
              AND payload ->> 'terminal' = 'true'
              AND (NOT (payload ? 'integration') OR payload ->> 'integration' = 'native_queue')
            )
            OR (
              event_type = 'merge.dequeued'
              AND payload ->> 'reason' IN ('blocked', 'failed', 'conflict')
              AND (NOT (payload ? 'integration') OR payload ->> 'integration' = 'native_queue')
            )
          )
     ),
     payload_member_ids AS (
       SELECT s.id,
              NULLIF(member ->> 'specId', '') AS spec_id,
              NULLIF(member ->> 'prUrl', '') AS pr_url,
              NULLIF(member ->> 'prNumber', '') AS pr_number
         FROM signal_events s
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(s.payload -> 'members') = 'array' THEN s.payload -> 'members'
             ELSE '[]'::jsonb
           END
         ) AS member
     ),
     payload_spec_ids AS (
       SELECT id,
              NULLIF(payload ->> 'specId', '') AS spec_id,
              NULLIF(payload ->> 'prUrl', '') AS pr_url,
              NULLIF(payload ->> 'prNumber', '') AS pr_number
         FROM signal_events
     ),
     payload_ids AS (
       SELECT id, spec_id, pr_url, pr_number FROM payload_spec_ids WHERE spec_id IS NOT NULL
       UNION
       SELECT id, spec_id, pr_url, pr_number FROM payload_member_ids WHERE spec_id IS NOT NULL
     ),
     run_spec_ids AS (
       SELECT s.id, NULLIF(r.spec_id, '') AS spec_id, NULLIF(r.pr_url, '') AS pr_url
         FROM signal_events s
         INNER JOIN runs r
                 ON r.run_id = s.run_id
                AND r.project_id = $1
                AND r.org_id = $2
        WHERE s.run_id IS NOT NULL
     ),
     attributed AS (
       SELECT s.id,
              s.ts,
              s.event_type,
              s.payload ->> 'reason' AS dequeue_reason,
              p.spec_id,
              s.run_id,
              p.pr_url,
              COALESCE(p.pr_number, substring(p.pr_url from '/pull/([0-9]+)')) AS pr_number,
              r.id IS NOT NULL AS run_exists
         FROM signal_events s
         INNER JOIN payload_ids p ON p.id = s.id
          LEFT JOIN run_spec_ids r ON r.id = s.id
       UNION
       SELECT s.id,
              s.ts,
              s.event_type,
              s.payload ->> 'reason' AS dequeue_reason,
              s.spec_id,
              s.run_id,
              NULLIF(s.payload ->> 'prUrl', '') AS pr_url,
              COALESCE(NULLIF(s.payload ->> 'prNumber', ''), substring(NULLIF(s.payload ->> 'prUrl', '') from '/pull/([0-9]+)')) AS pr_number,
              r.id IS NOT NULL AS run_exists
         FROM signal_events s
          LEFT JOIN run_spec_ids r ON r.id = s.id
        WHERE s.spec_id IS NOT NULL
          AND (
            s.event_type <> 'merge.batch.infra_blocked'
            OR NOT EXISTS (SELECT 1 FROM payload_ids p WHERE p.id = s.id)
          )
       UNION
       SELECT s.id,
              s.ts,
              s.event_type,
              s.payload ->> 'reason' AS dequeue_reason,
              r.spec_id,
              s.run_id,
              COALESCE(NULLIF(s.payload ->> 'prUrl', ''), r.pr_url) AS pr_url,
              COALESCE(NULLIF(s.payload ->> 'prNumber', ''), substring(COALESCE(NULLIF(s.payload ->> 'prUrl', ''), r.pr_url) from '/pull/([0-9]+)')) AS pr_number,
              true AS run_exists
         FROM signal_events s
         INNER JOIN run_spec_ids r ON r.id = s.id
        WHERE r.spec_id IS NOT NULL
          AND s.spec_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payload_ids p WHERE p.id = s.id)
     ),
     active_blockers AS (
       SELECT b.spec_id
         FROM attributed b
        WHERE (
            b.event_type IN ('merge.queue.infra_blocked', 'merge.batch.infra_blocked')
            OR (
              b.event_type = 'merge.dequeued'
              AND (
                b.dequeue_reason IN ('blocked', 'failed')
                OR (
                  b.dequeue_reason = 'conflict'
                  AND (b.run_exists OR b.pr_url IS NOT NULL OR b.pr_number IS NOT NULL)
                )
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM attributed done
             WHERE done.spec_id = b.spec_id
               AND done.event_type = 'merge.completed'
               AND (done.ts > b.ts OR (done.ts = b.ts AND done.id > b.id))
               AND (
                 (done.run_id IS NOT NULL AND b.run_id IS NOT NULL AND done.run_id = b.run_id)
                 OR (done.pr_url IS NOT NULL AND b.pr_url IS NOT NULL AND done.pr_url = b.pr_url)
                 OR (
                   done.pr_url IS NULL
                   AND b.pr_url IS NULL
                   AND done.pr_number IS NOT NULL
                   AND b.pr_number IS NOT NULL
                   AND done.pr_number = b.pr_number
                 )
               )
          )
     )
     SELECT DISTINCT spec_id
       FROM active_blockers
      ORDER BY spec_id`,
    [args.projectId, args.orgId],
  );
  return new Set(result.rows.map((row) => row.spec_id));
}

// Same project-access gate the run/feed routes use: ToolAccessDeniedError is the
// project-access miss, folded into a 403. Returns undefined on success or the
// denial Response to short-circuit on.
async function gateProjectAccess(
  pool: pg.Pool,
  projectId: string,
  actor: ActorContext,
  c: Context,
): Promise<Response | undefined> {
  try {
    await assertProjectAccess(pool, projectId, actor);
    return undefined;
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return c.json({ error: "project_access_denied", message: error.message }, 403);
    }
    throw error;
  }
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
