// The event-feed read store for the run-detail API surface (routes/runs):
// recent-events snapshot, paginated per-run events, and the project activity
// feed. Each method emits the byte-identical SQL the route loaders used to
// inline and returns the raw `events` rows; redaction (by actor scope) and
// cursor encode/decode stay at the call site, which owns the route contract
// types (RunEventRow/ProjectFeedItem). orgId is a defense-in-depth tenant
// predicate on top of the org-scoped client.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The raw `events` projection shared by every read below. */
export interface RawEventRow {
  id: unknown;
  ts: unknown;
  run_id: unknown;
  task_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  event_type: unknown;
  payload: unknown;
}

const SELECT_EVENT_COLUMNS = "id, ts, run_id, task_id, spec_id, project_id, event_type, payload";

/** A keyset cursor over the (ts, id) ordering both paginated reads share. */
export interface EventCursor {
  ts: Date;
  id: number;
}

export const EventStore = {
  /**
   * The most-recent N events for a run, returned oldest-first for the snapshot
   * (the inner subquery takes the newest N, the outer re-orders ascending).
   */
  async selectRecentForRun(
    client: QueryClient,
    args: { runId: string; orgId: string; limit: number },
    _actor: ActorRef,
  ): Promise<RawEventRow[]> {
    const result = await client.query<RawEventRow>(
      `SELECT ${SELECT_EVENT_COLUMNS}
       FROM (
         SELECT ${SELECT_EVENT_COLUMNS}
           FROM events
          WHERE run_id = $1 AND org_id = $3
          ORDER BY ts DESC, id DESC
          LIMIT $2
       ) recent
      ORDER BY ts ASC, id ASC`,
      [args.runId, args.limit, args.orgId],
    );
    return result.rows;
  },

  /**
   * Forward keyset page of a run's events (oldest-first). Fetches `limit + 1`
   * so the caller can detect a next page; the cursor (when present) advances
   * past the last item shown.
   */
  async selectPageForRun(
    client: QueryClient,
    args: { runId: string; orgId: string; cursor: EventCursor | undefined; limit: number },
    _actor: ActorRef,
  ): Promise<RawEventRow[]> {
    const params: unknown[] = [args.runId, args.orgId];
    let cursorClause = "";
    if (args.cursor !== undefined) {
      params.push(args.cursor.ts, args.cursor.id);
      cursorClause = ` AND (ts, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(args.limit + 1);
    const result = await client.query<RawEventRow>(
      `SELECT ${SELECT_EVENT_COLUMNS}
       FROM events
      WHERE run_id = $1 AND org_id = $2${cursorClause}
      ORDER BY ts ASC, id ASC
      LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  },

  /**
   * Delta read for the SSE stream: events for a run with `id > sinceId`,
   * oldest-first, capped at 200. Distinct from the paginated read (id keyset,
   * not (ts, id)) because the stream tracks a monotonic last-seen event id.
   */
  async selectNewForRunSince(
    client: QueryClient,
    args: { runId: string; orgId: string; sinceId: number },
    _actor: ActorRef,
  ): Promise<RawEventRow[]> {
    const result = await client.query<RawEventRow>(
      `SELECT ${SELECT_EVENT_COLUMNS}
         FROM events
        WHERE run_id = $1 AND org_id = $3 AND id > $2
        ORDER BY ts ASC, id ASC
        LIMIT 200`,
      [args.runId, args.sinceId, args.orgId],
    );
    return result.rows;
  },

  /**
   * Backward keyset page of a project's run-scoped events (newest-first) for the
   * activity feed. The cursor (when present) goes backwards in time, encoding
   * the (ts, id) of the oldest item already shown.
   */
  async selectFeedPageForProject(
    client: QueryClient,
    args: { projectId: string; orgId: string; cursor: EventCursor | undefined; limit: number },
    _actor: ActorRef,
  ): Promise<RawEventRow[]> {
    const params: unknown[] = [args.projectId, args.orgId];
    let cursorClause = "";
    if (args.cursor !== undefined) {
      params.push(args.cursor.ts, args.cursor.id);
      cursorClause = ` AND (ts, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(args.limit + 1);
    const result = await client.query<RawEventRow>(
      `SELECT ${SELECT_EVENT_COLUMNS}
       FROM events
      WHERE project_id = $1 AND org_id = $2 AND run_id IS NOT NULL${cursorClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  },
} as const;
