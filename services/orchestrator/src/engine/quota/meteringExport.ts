// Usage-metering export — the clean READ seam a hosting layer consumes to bill.
// This is NOT billing logic: it derives a typed usage rollup straight from
// `cost_records` grouped by org_id (the rich, token-typed, multi-basis cost
// ledger). The hosting layer maps this to its own pricing/credits outside the
// repo.
//
// Two reads:
//   - getOrgUsage(orgId, window?) — an aggregate rollup (runs, tokens, dollars)
//     for one org over an optional time window. The data point a meter samples.
//   - streamBillableRuns(orgId, window?) — per-run billable events (one row per
//     run with its token + dollar totals), the granular stream a hosting layer
//     ingests to attribute charges to runs.
//
// `costUsd` is best-effort in the ledger (NULL when no reliable basis exists);
// the rollup sums COALESCE(cost_usd, 0) so an unpriced run contributes 0
// dollars but still counts its tokens. Token accounting is mandatory + exact.

import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** An optional half-open time window [from, to) over `cost_records.recorded_at`.
 * Both bounds optional: omit `from` for "since the beginning", omit `to` for
 * "up to now". The hosting layer owns billing-period semantics; this is a plain
 * timestamp filter, not a quota window. */
export interface UsageWindow {
  from?: Date;
  to?: Date;
}

/** Aggregate usage for one org. Tokens are exact; costUsd sums the known
 * dollar figures (unpriced rows contribute 0). */
export interface OrgUsage {
  orgId: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

/** One billable run: its token + dollar totals, for a per-run export stream. */
export interface BillableRun {
  runId: string;
  tokens: number;
  costUsd: number;
}

const UsageRowSchema = z.object({
  runs: z.coerce.number(),
  tokens: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

const BillableRunRowSchema = z.object({
  run_id: z.string(),
  tokens: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

/** Append the optional time-window predicate, returning the SQL fragment + the
 * positional params that follow `$1` (the orgId). */
function windowClause(window: UsageWindow | undefined, startIndex: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql = "";
  let index = startIndex;
  if (window?.from !== undefined) {
    sql += ` AND recorded_at >= $${index}`;
    params.push(window.from);
    index += 1;
  }
  if (window?.to !== undefined) {
    sql += ` AND recorded_at < $${index}`;
    params.push(window.to);
  }
  return { sql, params };
}

/**
 * Aggregate usage for one org over an optional window. A clean read derived
 * from `cost_records`: COUNT(DISTINCT run_id) runs, SUM(total_tokens) tokens,
 * SUM(COALESCE(cost_usd,0)) dollars. Returns zeros for an org with no rows.
 */
export async function getOrgUsage(pool: QueryClient, orgId: string, window?: UsageWindow): Promise<OrgUsage> {
  const { sql, params } = windowClause(window, 2);
  const result = await pool.query(
    `SELECT
       COUNT(DISTINCT run_id) AS runs,
       COALESCE(SUM(total_tokens), 0) AS tokens,
       COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd
     FROM cost_records
     WHERE org_id = $1${sql}`,
    [orgId, ...params],
  );
  const row = UsageRowSchema.parse(result.rows[0] ?? { runs: 0, tokens: 0, cost_usd: 0 });
  return { orgId, runs: row.runs, tokens: row.tokens, costUsd: row.cost_usd };
}

/**
 * Per-run billable events for one org over an optional window — the granular
 * stream a hosting layer ingests to attribute charges. One row per run with its
 * summed tokens + dollars, ordered by run id for stable pagination.
 */
export async function streamBillableRuns(
  pool: QueryClient,
  orgId: string,
  window?: UsageWindow,
): Promise<BillableRun[]> {
  const { sql, params } = windowClause(window, 2);
  const result = await pool.query(
    `SELECT
       run_id,
       COALESCE(SUM(total_tokens), 0) AS tokens,
       COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd
     FROM cost_records
     WHERE org_id = $1${sql}
     GROUP BY run_id
     ORDER BY run_id`,
    [orgId, ...params],
  );
  return result.rows.map((raw) => {
    const row = BillableRunRowSchema.parse(raw);
    return { runId: row.run_id, tokens: row.tokens, costUsd: row.cost_usd };
  });
}

/**
 * The real usage a single completed run consumed, summed from its
 * `cost_records` rows. The run-executor's post-run accrual hook calls this to
 * feed {@link QuotaPolicy.accrueUsage} ground truth. Returns zero tokens/cost
 * for a run that recorded no cost rows (e.g. denied/empty run).
 */
export async function getRunUsage(pool: QueryClient, runId: string): Promise<{ tokens: number; costUsd: number }> {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(total_tokens), 0) AS runs,
       COALESCE(SUM(total_tokens), 0) AS tokens,
       COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd
     FROM cost_records
     WHERE run_id = $1`,
    [runId],
  );
  const row = UsageRowSchema.parse(result.rows[0] ?? { runs: 0, tokens: 0, cost_usd: 0 });
  return { tokens: row.tokens, costUsd: row.cost_usd };
}
