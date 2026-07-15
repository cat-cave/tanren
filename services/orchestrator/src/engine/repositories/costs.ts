// The cost-record read store for the run-detail API surface (routes/runs): the
// per-run cost snapshot plus the paginated costs view. Each method emits the
// byte-identical SQL the route loaders used to inline and returns the raw
// `cost_records` rows; decoding into the route's RunCostRecord and cursor
// encode/decode stay at the call site. orgId is a defense-in-depth tenant
// predicate on top of the org-scoped client.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const SELECT_COST_COLUMNS = `id, task_id, run_id, project_id, cli, provider, model,
            input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
            cost_usd, billing_mode, cost_basis, recorded_at`;

/** A keyset cursor over the (recorded_at, id) ordering the paginated read uses. */
export interface CostCursor {
  ts: Date;
  id: number;
}

export const CostStore = {
  /** All cost records for a run (org-scoped), oldest-first, for the snapshot. */
  async selectForRun(
    client: QueryClient,
    args: { runId: string; orgId: string },
    _actor: ActorRef,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COST_COLUMNS}
       FROM cost_records
      WHERE run_id = $1 AND org_id = $2
      ORDER BY recorded_at ASC, id ASC`,
      [args.runId, args.orgId],
    );
    return result.rows;
  },

  /**
   * Delta read for the SSE stream: cost records for a run with `id > sinceId`,
   * oldest-first, capped at 200. The stream tracks a monotonic last-seen id, so
   * this is an id-keyset read distinct from the (recorded_at, id) paginated one.
   */
  async selectNewForRunSince(
    client: QueryClient,
    args: { runId: string; orgId: string; sinceId: string },
    _actor: ActorRef,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COST_COLUMNS}
         FROM cost_records
        WHERE run_id = $1 AND org_id = $3 AND id > $2
        ORDER BY id ASC
        LIMIT 200`,
      [args.runId, args.sinceId, args.orgId],
    );
    return result.rows;
  },

  /**
   * Forward keyset page of a run's cost records (oldest-first). Fetches
   * `limit + 1` so the caller can detect a next page; the cursor (when present)
   * advances past the last item shown.
   */
  async selectPageForRun(
    client: QueryClient,
    args: { runId: string; orgId: string; cursor: CostCursor | undefined; limit: number },
    _actor: ActorRef,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const params: unknown[] = [args.runId, args.orgId];
    let cursorClause = "";
    if (args.cursor !== undefined) {
      params.push(args.cursor.ts, args.cursor.id);
      cursorClause = ` AND (recorded_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(args.limit + 1);
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COST_COLUMNS}
       FROM cost_records
      WHERE run_id = $1 AND org_id = $2${cursorClause}
      ORDER BY recorded_at ASC, id ASC
      LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  },
} as const;
