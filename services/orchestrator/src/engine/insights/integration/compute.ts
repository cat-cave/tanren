// Integration `rebase_vs_rebuild` metric computation (tanren-owns-the-engine.md
// §3/§7/§8 — the never-discard read-side). Pure reducer
// (`deriveIntegrationMetrics`) over rows the engine already persists, plus a thin
// DB loader (`computeIntegrationMetrics`) that pulls those rows for a project +
// window. No new data collection and no migration: the `integration.rebase` event
// records a CATEGORICAL `decision` only; the token/wall-clock COST is JOINED AT
// READ TIME from `cost_records` (summed by `run_id`) and `runs`
// (`ended_at - started_at` — `runs` has NO `duration_ms`). The event payload is
// NEVER widened.
//
// Inputs (all read-only):
//   - rebases:   `integration.rebase` events in the window → one row per base
//                shift, carrying its `runId` + `decision`.
//   - costs:     per-`run_id` summed `cost_records` (total_tokens, cost_usd).
//   - runs:      per-`run_id` wall-clock (`ended_at - started_at`).
//   - proofReuseCount: how many `integration.proof.reused` events fired.

import type pg from "pg";
import { IntegrationMetrics, type IntegrationDecisionBucket, type RebaseDecision } from "./types.js";

const DEFAULT_WINDOW_DAYS = 30;

/** One `integration.rebase` event: the shift's kept run + what it cost. */
export interface RebaseEventRow {
  /** The KEPT run id (the never-discard proof — same row across the base shift). */
  runId: string;
  /** What the base shift cost — the `rebase_vs_rebuild` signal. */
  decision: RebaseDecision;
}

/** Summed cost for one `run_id`, joined at read time (NOT carried on the event). */
export interface RunCostRow {
  runId: string;
  /** Total LLM tokens summed across the run's `cost_records`. */
  totalTokens: number;
  /** Total USD cost summed across the run's `cost_records` (null when unpriced). */
  costUsd: number | null;
}

/** A run's wall-clock window, joined at read time (`runs` has no `duration_ms`). */
export interface RunDurationRow {
  runId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface IntegrationInputs {
  rebases: RebaseEventRow[];
  costs: RunCostRow[];
  runs: RunDurationRow[];
  proofReuseCount: number;
}

export interface DeriveIntegrationOptions {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
}

const DECISIONS: readonly RebaseDecision[] = ["rebased_clean", "rebased_resolved", "replanned", "held"];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function bucketFor(
  runIds: string[],
  tokensByRun: Map<string, number>,
  wallClockByRun: Map<string, number>,
): IntegrationDecisionBucket {
  const tokens = runIds.map((id) => tokensByRun.get(id)).filter((t): t is number => t !== undefined);
  const wall = runIds.map((id) => wallClockByRun.get(id)).filter((s): s is number => s !== undefined);
  return {
    count: runIds.length,
    medianTokens: median(tokens),
    tokensSample: tokens.length,
    medianWallClockSeconds: median(wall),
    wallClockSample: wall.length,
  };
}

/**
 * Pure integration-metrics reducer. Deterministic over its inputs; the DB loader
 * below is the only impure shell. Returns a fully-typed, schema-valid
 * `IntegrationMetrics`. The cost rows are JOINED to the rebase events by `runId` —
 * the event itself carries only the categorical `decision`.
 */
export function deriveIntegrationMetrics(
  inputs: IntegrationInputs,
  options: DeriveIntegrationOptions,
): IntegrationMetrics {
  const { rebases, costs, runs, proofReuseCount } = inputs;

  // Index the read-time cost/wall-clock joins by run id.
  const tokensByRun = new Map<string, number>();
  for (const c of costs) tokensByRun.set(c.runId, c.totalTokens);

  const wallClockByRun = new Map<string, number>();
  for (const r of runs) {
    if (r.endedAt === null) continue;
    const seconds = (r.endedAt.getTime() - r.startedAt.getTime()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) wallClockByRun.set(r.runId, seconds);
  }

  // Group the kept run ids by their recorded decision.
  const runIdsByDecision = new Map<RebaseDecision, string[]>();
  for (const d of DECISIONS) runIdsByDecision.set(d, []);
  for (const ev of rebases) runIdsByDecision.get(ev.decision)?.push(ev.runId);

  const buckets = {
    rebased_clean: bucketFor(runIdsByDecision.get("rebased_clean")!, tokensByRun, wallClockByRun),
    rebased_resolved: bucketFor(runIdsByDecision.get("rebased_resolved")!, tokensByRun, wallClockByRun),
    replanned: bucketFor(runIdsByDecision.get("replanned")!, tokensByRun, wallClockByRun),
    held: bucketFor(runIdsByDecision.get("held")!, tokensByRun, wallClockByRun),
  };

  // Headline rebase_vs_rebuild: kept-alive (clean + resolved) vs replanned (rebuilt).
  const keptAliveRunIds = [...runIdsByDecision.get("rebased_clean")!, ...runIdsByDecision.get("rebased_resolved")!];
  const keptAliveTokens = keptAliveRunIds.map((id) => tokensByRun.get(id)).filter((t): t is number => t !== undefined);
  const replannedTokens = runIdsByDecision
    .get("replanned")!
    .map((id) => tokensByRun.get(id))
    .filter((t): t is number => t !== undefined);
  const keptAliveMedian = median(keptAliveTokens);
  const replannedMedian = median(replannedTokens);
  const rebaseCheaper = keptAliveMedian === null || replannedMedian === null ? null : keptAliveMedian < replannedMedian;

  return IntegrationMetrics.parse({
    projectId: options.projectId,
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    windowDays: options.windowDays,
    buckets,
    rebaseVsRebuild: {
      keptAliveMedianTokens: keptAliveMedian,
      keptAliveSample: keptAliveTokens.length,
      replannedMedianTokens: replannedMedian,
      replannedSample: replannedTokens.length,
      rebaseCheaper,
    },
    proofReuseCount,
    totalRebases: rebases.length,
    computedAt: options.windowEnd.toISOString(),
  });
}

export interface ComputeIntegrationOptions {
  projectId: string;
  now?: Date;
  windowDays?: number;
}

interface RebaseQueryRow {
  run_id: string;
  decision: string;
}
interface CostQueryRow {
  run_id: string;
  total_tokens: string | number;
  cost_usd: string | number | null;
}
interface RunDurationQueryRow {
  run_id: string;
  started_at: Date;
  ended_at: Date | null;
}
interface ProofReuseCountRow {
  reuse_count: string | number;
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Load the read-only inputs for a project + window and reduce them to the
 * `rebase_vs_rebuild` metrics. The queries touch only `events`, `cost_records`,
 * and `runs` — all pre-existing tables. The token/wall-clock COST is JOINED HERE
 * (read time): the `integration.rebase` payload carries only the categorical
 * `decision`, never a cost figure.
 */
export async function computeIntegrationMetrics(
  pool: Pick<pg.Pool, "query">,
  options: ComputeIntegrationOptions,
): Promise<IntegrationMetrics> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // One row per `integration.rebase` event in the window — the kept run + decision.
  const rebaseResult = await pool.query<RebaseQueryRow>(
    `SELECT e.payload->>'runId' AS run_id,
            e.payload->>'decision' AS decision
       FROM events e
       WHERE e.event_type = 'integration.rebase'
         AND e.project_id = $1
         AND e.ts >= $2
         AND e.payload->>'runId' IS NOT NULL
         AND e.payload->>'decision' IS NOT NULL
       ORDER BY e.ts ASC`,
    [options.projectId, since],
  );

  const runIds = [...new Set(rebaseResult.rows.map((r) => r.run_id))];

  // Read-time cost join: total tokens + USD summed per run from `cost_records`.
  const costResult =
    runIds.length === 0
      ? { rows: [] as CostQueryRow[] }
      : await pool.query<CostQueryRow>(
          `SELECT c.run_id,
                  SUM(c.total_tokens) AS total_tokens,
                  SUM(c.cost_usd) AS cost_usd
             FROM cost_records c
            WHERE c.project_id = $1
              AND c.run_id = ANY($2::text[])
            GROUP BY c.run_id`,
          [options.projectId, runIds],
        );

  // Read-time wall-clock join: `runs` has NO duration_ms — derive it from
  // `ended_at - started_at` in the reducer.
  const runDurationResult =
    runIds.length === 0
      ? { rows: [] as RunDurationQueryRow[] }
      : await pool.query<RunDurationQueryRow>(
          `SELECT r.run_id, r.started_at, r.ended_at
             FROM runs r
            WHERE r.project_id = $1
              AND r.run_id = ANY($2::text[])`,
          [options.projectId, runIds],
        );

  // Proof-reuse count: least-repeated-work events in the same window.
  const proofResult = await pool.query<ProofReuseCountRow>(
    `SELECT COUNT(*) AS reuse_count
       FROM events e
      WHERE e.event_type = 'integration.proof.reused'
        AND e.project_id = $1
        AND e.ts >= $2`,
    [options.projectId, since],
  );

  const inputs: IntegrationInputs = {
    rebases: rebaseResult.rows.map((row) => ({
      runId: row.run_id,
      decision: row.decision as RebaseDecision,
    })),
    costs: costResult.rows.map((row) => ({
      runId: row.run_id,
      totalTokens: toNumber(row.total_tokens),
      costUsd: row.cost_usd === null ? null : toNumber(row.cost_usd),
    })),
    runs: runDurationResult.rows.map((row) => ({
      runId: row.run_id,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at === null ? null : new Date(row.ended_at),
    })),
    proofReuseCount: toNumber(proofResult.rows[0]?.reuse_count ?? 0),
  };

  return deriveIntegrationMetrics(inputs, {
    projectId: options.projectId,
    windowStart: since,
    windowEnd: now,
    windowDays,
  });
}
