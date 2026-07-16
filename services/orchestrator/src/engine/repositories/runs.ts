import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import { RunOutcome, RunStatus, transitionRun } from "../state/run.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const RunRow = z.object({
  runId: z.string(),
  specId: z.string(),
  projectId: z.string(),
  trigger: z.string(),
  branch: z.string(),
  status: RunStatus,
  outcome: RunOutcome.nullable(),
  prUrl: z.string().nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  orgId: z.string(),
  userId: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

interface RawRunRow {
  run_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  trigger: unknown;
  branch: unknown;
  status: unknown;
  outcome: unknown;
  pr_url: unknown;
  started_at: unknown;
  ended_at: unknown;
  org_id: unknown;
  user_id: unknown;
}

const SELECT_RUN_COLUMNS = `
  run_id,
  spec_id,
  project_id,
  trigger,
  branch,
  status,
  outcome,
  pr_url,
  started_at,
  ended_at,
  org_id,
  user_id
`;

function decodeRunRow(raw: RawRunRow): RunRow {
  return RunRow.parse({
    runId: raw.run_id,
    specId: raw.spec_id,
    projectId: raw.project_id,
    trigger: raw.trigger,
    branch: raw.branch,
    status: raw.status,
    outcome: raw.outcome,
    prUrl: raw.pr_url,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    orgId: raw.org_id,
    userId: raw.user_id,
  });
}

// ---------------------------------------------------------------------------
// Run-detail / run-list read projections (the route loaders).
//
// The run-detail API surface (routes/runs) projects a narrower, route-specific
// column set than the canonical RunRow (no user_id; the list view joins the
// spec title and aggregates cost/last-event). These raw-row read methods carry
// the byte-identical SQL the loaders used to inline; decoding into the route's
// contract types (RunSummary/RunListItem) — including the redaction/needs-review
// derivations — stays at the call site, which is the layer that owns those types.
// orgId is a defense-in-depth tenant predicate on top of the org-scoped client.
// ---------------------------------------------------------------------------

/** The run-detail summary projection (no user_id; ordered for the route). */
export interface RawRunSummaryRow {
  run_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  trigger: unknown;
  branch: unknown;
  status: unknown;
  outcome: unknown;
  pr_url: unknown;
  started_at: unknown;
  ended_at: unknown;
}

const SELECT_RUN_SUMMARY_COLUMNS = `
  run_id, spec_id, project_id, trigger, branch, status, outcome, pr_url, started_at, ended_at
`;

/** Adds the spec title + cost/last-event aggregates the project run list shows. */
export interface RawRunListRow extends RawRunSummaryRow {
  spec_title: string | null;
  cost_total_usd: string | null;
  last_event_at: Date | null;
}

export interface RunListProjectionFilter {
  projectId: string;
  orgId: string;
  status: string | undefined;
  specId: string | undefined;
}

/** Keyset for the org run projection's newest-first stable ordering. */
export interface OrgRunCursor {
  startedAt: Date;
  runId: string;
}

const COMPLETE_REAL_COST_TOTAL = `CASE
                WHEN COUNT(cr.id) = 0 THEN '0'
                WHEN COUNT(cr.cost_usd) = COUNT(cr.id) THEN SUM(cr.cost_usd::numeric)::text
                ELSE NULL
              END`;

export const RunStore = {
  async get(client: QueryClient, runId: string, _actor: ActorRef): Promise<RunRow | undefined> {
    const result = await client.query<RawRunRow>(`SELECT ${SELECT_RUN_COLUMNS} FROM runs WHERE run_id = $1`, [runId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeRunRow(row);
  },

  async list(client: QueryClient, filter: { projectId?: string } | undefined, _actor: ActorRef): Promise<RunRow[]> {
    const projectId = filter?.projectId;
    const result =
      projectId === undefined
        ? await client.query<RawRunRow>(`SELECT ${SELECT_RUN_COLUMNS} FROM runs ORDER BY started_at DESC`)
        : await client.query<RawRunRow>(
            `SELECT ${SELECT_RUN_COLUMNS} FROM runs WHERE project_id = $1 ORDER BY started_at DESC`,
            [projectId],
          );
    return result.rows.map((row) => decodeRunRow(row));
  },

  /**
   * Run-detail summary read: the narrower route projection, filtered by run +
   * org. Returns the raw projected row (the route decodes it into RunSummary).
   */
  async selectSummary(
    client: QueryClient,
    runId: string,
    orgId: string,
    _actor: ActorRef,
  ): Promise<RawRunSummaryRow | undefined> {
    const result = await client.query<RawRunSummaryRow>(
      `SELECT ${SELECT_RUN_SUMMARY_COLUMNS} FROM runs WHERE run_id = $1 AND org_id = $2`,
      [runId, orgId],
    );
    return result.rows[0];
  },

  /**
   * Project run-list read: the summary projection plus spec title and the
   * per-run cost / last-event aggregates, filtered by project + org with
   * optional status/spec predicates. Returns raw rows; the route derives
   * RunListItem (specTitle/costTotalUsd/lastEventAt/needsReview) from them.
   */
  async selectListForProject(
    client: QueryClient,
    filter: RunListProjectionFilter,
    _actor: ActorRef,
  ): Promise<RawRunListRow[]> {
    const params: unknown[] = [filter.projectId, filter.orgId];
    const clauses: string[] = ["r.project_id = $1", "r.org_id = $2"];
    if (filter.status !== undefined && filter.status !== "") {
      params.push(filter.status);
      clauses.push(`r.status = $${params.length}`);
    }
    if (filter.specId !== undefined && filter.specId !== "") {
      params.push(filter.specId);
      clauses.push(`r.spec_id = $${params.length}`);
    }
    const where = clauses.join(" AND ");
    const result = await client.query<RawRunListRow>(
      `SELECT r.run_id, r.spec_id, r.project_id, r.trigger, r.branch, r.status, r.outcome,
              r.pr_url, r.started_at, r.ended_at,
              s.title AS spec_title,
              (SELECT ${COMPLETE_REAL_COST_TOTAL}
                 FROM cost_records cr
                WHERE cr.run_id = r.run_id AND cr.org_id = $2) AS cost_total_usd,
              (SELECT MAX(e.ts)
                 FROM events e
                WHERE e.run_id = r.run_id AND e.org_id = $2) AS last_event_at
         FROM runs r
         LEFT JOIN specs s ON s.spec_id = r.spec_id AND s.project_id = r.project_id AND s.org_id = $2
        WHERE ${where}
        ORDER BY r.started_at DESC, r.run_id ASC`,
      params,
    );
    return result.rows;
  },

  /**
   * Bounded org-wide run page used by the costs read model. A run with no cost
   * rows has a known zero total; any null real-dollar row makes the complete
   * total unknown (null), including a mixed priced/unpriced run.
   */
  async selectCostListPageForOrg(
    client: QueryClient,
    args: { orgId: string; cursor: OrgRunCursor | undefined; limit: number },
    _actor: ActorRef,
  ): Promise<RawRunListRow[]> {
    const params: unknown[] = [args.orgId];
    let cursorClause = "";
    if (args.cursor !== undefined) {
      params.push(args.cursor.startedAt, args.cursor.runId);
      cursorClause = ` AND (r.started_at < $${params.length - 1}::timestamptz
        OR (r.started_at = $${params.length - 1}::timestamptz AND r.run_id > $${params.length}))`;
    }
    params.push(args.limit + 1);
    const result = await client.query<RawRunListRow>(
      `SELECT r.run_id, r.spec_id, r.project_id, r.trigger, r.branch, r.status, r.outcome,
              r.pr_url, r.started_at, r.ended_at,
              s.title AS spec_title,
              (SELECT ${COMPLETE_REAL_COST_TOTAL}
                 FROM cost_records cr
                WHERE cr.run_id = r.run_id AND cr.org_id = $1) AS cost_total_usd,
              (SELECT MAX(e.ts)
                 FROM events e
                WHERE e.run_id = r.run_id AND e.org_id = $1) AS last_event_at
         FROM runs r
         LEFT JOIN specs s ON s.spec_id = r.spec_id AND s.project_id = r.project_id AND s.org_id = $1
        WHERE r.org_id = $1${cursorClause}
        ORDER BY r.started_at DESC, r.run_id ASC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  },

  async updateStatus(
    client: QueryClient,
    runId: string,
    next: {
      from: z.infer<typeof RunStatus>;
      to: z.infer<typeof RunStatus>;
      outcome?: z.infer<typeof RunOutcome>;
      setEndedAt?: boolean;
    },
    _actor: ActorRef,
  ): Promise<RunRow> {
    transitionRun(next.from, next.to);
    const params: unknown[] = [runId, next.to];
    let setOutcome = "";
    if (next.outcome !== undefined) {
      params.push(next.outcome);
      setOutcome = `, outcome = $${params.length}`;
    }
    const setEnded = next.setEndedAt === true ? ", ended_at = now()" : "";
    const result = await client.query<RawRunRow>(
      `UPDATE runs SET status = $2${setOutcome}${setEnded} WHERE run_id = $1 RETURNING ${SELECT_RUN_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    return decodeRunRow(row);
  },
} as const;
