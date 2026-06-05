// Thin DB seam for the BenchmarkRunner (docs/roadmap/tanren-method-benchmark.md
// §4.2 item 2). The runner is a SCHEDULER over the existing worker run-executor;
// this module is its narrow read/write surface — load a cell + its experiment,
// poll a run to terminal, read recent provider rate-limit observations (for
// §3.3 spacing), and write the `experiment_trials` join row. Every tenant-table
// op runs org-scoped (RLS); the heavy per-run data stays in runs/events/
// cost_records and is read by the foundation's `loadTrialScorecard`.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import { ExperimentCellRow, ExperimentRow, FrozenConfig, SeedTaskRef } from "./entities.js";
import type { AcceptResult } from "./entities.js";
import type { TrialScorecard } from "./scorecard.js";

/** A cell joined to its parent experiment — everything a trial needs to run. */
export interface CellWithExperiment {
  cell: ExperimentCellRow;
  experiment: ExperimentRow;
  frozenConfig: FrozenConfig;
  seedTaskRef: SeedTaskRef;
}

const CellJoinRow = z.object({
  cell_id: z.string(),
  experiment_id: z.string(),
  label: z.string(),
  frozen_config: z.unknown(),
  trials_target: z.number().int(),
  org_id: z.string(),
  title: z.string(),
  knob: z.string(),
  hypothesis: z.string(),
  seed_task_ref: z.unknown(),
  created_at: z.coerce.date(),
});

/** A terminal-run status snapshot the scheduler polls toward. */
export interface RunStatusSnapshot {
  status: string;
  outcome: string | null;
  merged: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "halted", "failed", "cancelled"]);
const MERGED_STATUSES = new Set(["completed"]);

export class CellNotFoundError extends Error {
  constructor(readonly cellId: string) {
    super(`experiment cell not found (or not visible under org scope): ${cellId}`);
    this.name = "CellNotFoundError";
  }
}

/**
 * Load a cell + its parent experiment under the org's scope. Returns the typed
 * frozen config + seed task ref the trials provision from. Throws
 * `CellNotFoundError` when the cell is invisible (cross-org → zero rows under
 * RLS) so a mis-scoped call fails loudly rather than silently running nothing.
 */
export async function loadCellWithExperiment(
  pool: pg.Pool,
  orgId: string,
  cellId: string,
): Promise<CellWithExperiment> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT c.cell_id, c.experiment_id, c.label, c.frozen_config, c.trials_target,
              e.org_id, e.title, e.knob, e.hypothesis, e.seed_task_ref, e.created_at
         FROM experiment_cells c
         INNER JOIN experiments e ON e.experiment_id = c.experiment_id
        WHERE c.cell_id = $1`,
      [cellId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new CellNotFoundError(cellId);
    const decoded = CellJoinRow.parse(row);
    const frozenConfig = FrozenConfig.parse(decoded.frozen_config);
    const seedTaskRef = SeedTaskRef.parse(decoded.seed_task_ref);
    return {
      cell: ExperimentCellRow.parse({
        cellId: decoded.cell_id,
        experimentId: decoded.experiment_id,
        label: decoded.label,
        frozenConfig,
        trialsTarget: decoded.trials_target,
      }),
      experiment: ExperimentRow.parse({
        experimentId: decoded.experiment_id,
        orgId: decoded.org_id,
        title: decoded.title,
        knob: decoded.knob,
        hypothesis: decoded.hypothesis,
        seedTaskRef,
        createdAt: decoded.created_at,
      }),
      frozenConfig,
      seedTaskRef,
    };
  });
}

/** The cell ids of an experiment, in insertion order. */
export async function loadExperimentCellIds(pool: pg.Pool, orgId: string, experimentId: string): Promise<string[]> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ cell_id: string }>(
      `SELECT cell_id FROM experiment_cells WHERE experiment_id = $1 ORDER BY cell_id ASC`,
      [experimentId],
    );
    return result.rows.map((r) => r.cell_id);
  });
}

/** The org that owns an experiment (the bootstrap for every scoped op). */
export async function loadExperimentOrgId(pool: pg.Pool, experimentId: string): Promise<string | null> {
  // System-scope read (BYPASSRLS system pool when configured): discover the org
  // BEFORE any tenant work, exactly as the worker bootstraps a claimed job's org
  // from the queue. Under enforced RLS an empty-GUC read on the restricted role
  // would see zero rows, so this MUST run cross-org, never org-scoped.
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string }>(`SELECT org_id FROM experiments WHERE experiment_id = $1`, [
      experimentId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

/** The org that owns a cell (via its experiment) — the per-cell org bootstrap. */
export async function loadCellOrgId(pool: pg.Pool, cellId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string }>(
      `SELECT e.org_id
         FROM experiment_cells c
         INNER JOIN experiments e ON e.experiment_id = c.experiment_id
        WHERE c.cell_id = $1`,
      [cellId],
    );
    return result.rows[0]?.org_id ?? null;
  });
}

/**
 * Read the current status of a run under org scope. Returns undefined when the
 * run is not yet visible / not found (the poller keeps waiting). `merged` is
 * true only for a clean terminal (`completed`).
 */
export async function readRunStatus(
  pool: pg.Pool,
  orgId: string,
  runId: string,
): Promise<RunStatusSnapshot | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ status: string; outcome: string | null }>(
      `SELECT status, outcome FROM runs WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return;
    return { status: row.status, outcome: row.outcome, merged: MERGED_STATUSES.has(row.status) };
  });
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** A recent provider rate-limit observation that gates the next trial (§3.3). */
export interface RateLimitGate {
  provider: string;
  observation: string;
  retryAfterS: number | null;
  ts: Date;
}

const RATE_LIMIT_EXHAUSTED = new Set(["window_exhausted", "rate_limited", "exhausted"]);

/**
 * Read the most recent rate-limit observation for a provider that would confound
 * a trial's wall-clock/cost (§3.3): a window-exhausted / rate-limited state. The
 * scheduler uses this to AVOID starting trial N+1 under a provider window that is
 * exhausted while trial N ran under a fresh one. `rate_limit_observations` has no
 * org_id (it is provider/account state, not tenant data), so this reads off the
 * pool directly. Returns undefined when no recent gating observation exists.
 */
export async function readActiveRateLimitGate(
  pool: pg.Pool,
  provider: string,
  sinceMs: number,
): Promise<RateLimitGate | undefined> {
  const result = await pool.query<{ observation: string; retry_after_s: number | null; ts: Date }>(
    `SELECT observation, retry_after_s, ts
       FROM rate_limit_observations
      WHERE provider = $1 AND ts >= $2
      ORDER BY ts DESC
      LIMIT 1`,
    [provider, new Date(sinceMs)],
  );
  const row = result.rows[0];
  if (row === undefined || !RATE_LIMIT_EXHAUSTED.has(row.observation)) return undefined;
  return {
    provider,
    observation: row.observation,
    retryAfterS: row.retry_after_s === null ? null : Number(row.retry_after_s),
    ts: new Date(row.ts),
  };
}

/**
 * Write the `experiment_trials` join row under org scope (RLS-enforced via the
 * cell's parent chain). The scorecard is the cached projection; accept_result is
 * the post-merge oracle outcome (null when the run never merged). Idempotent on
 * (cell_id, trial_index) — a re-run upserts the same trial rather than erroring.
 */
export async function writeTrialRow(
  pool: pg.Pool,
  orgId: string,
  input: {
    trialId: string;
    cellId: string;
    runId: string;
    trialIndex: number;
    acceptResult: AcceptResult | null;
    scorecard: TrialScorecard;
  },
): Promise<void> {
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(
      `INSERT INTO experiment_trials (trial_id, cell_id, run_id, trial_index, accept_result, scorecard)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (cell_id, trial_index)
       DO UPDATE SET run_id = EXCLUDED.run_id,
                     accept_result = EXCLUDED.accept_result,
                     scorecard = EXCLUDED.scorecard`,
      [input.trialId, input.cellId, input.runId, input.trialIndex, input.acceptResult, JSON.stringify(input.scorecard)],
    );
  });
}
