// Thin CRUD + read store for the benchmark report surface (docs/roadmap/
// tanren-method-benchmark.md §4.2 item 4). The HTTP routes + CLI author
// experiments/cells, trigger runs (via the runner), and read cell-vs-cell
// results — this module is their narrow org-scoped DB seam. It does NOT compute:
// the heavy projection lives in scorecard.ts (cached per trial) and the
// aggregation in reducers.ts; here we only persist rows and read back the cached
// `TrialScorecard`s that the reducers consume. Every tenant-table op runs
// org-scoped (RLS): `experiments` carries org_id directly; `experiment_cells`
// derive their org via the parent experiment (migration 0033 policies).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import { ExperimentCellRow, ExperimentRow, FrozenConfig, SeedTaskRef } from "./entities.js";
import { TrialScorecard } from "./scorecard.js";

// ---- Errors ---------------------------------------------------------------

export class ExperimentNotFoundError extends Error {
  constructor(readonly experimentId: string) {
    super(`experiment not found (or not visible under org scope): ${experimentId}`);
    this.name = "ExperimentNotFoundError";
  }
}

export class CellNotFoundError extends Error {
  constructor(readonly cellId: string) {
    super(`experiment cell not found (or not visible under org scope): ${cellId}`);
    this.name = "CellNotFoundError";
  }
}

// ---- Row decoders ---------------------------------------------------------

const ExperimentDbRow = z.object({
  experiment_id: z.string(),
  org_id: z.string(),
  title: z.string(),
  knob: z.string(),
  hypothesis: z.string(),
  seed_task_ref: z.unknown(),
  created_at: z.coerce.date(),
});

function decodeExperiment(row: unknown): ExperimentRow {
  const decoded = ExperimentDbRow.parse(row);
  return ExperimentRow.parse({
    experimentId: decoded.experiment_id,
    orgId: decoded.org_id,
    title: decoded.title,
    knob: decoded.knob,
    hypothesis: decoded.hypothesis,
    seedTaskRef: SeedTaskRef.parse(decoded.seed_task_ref),
    createdAt: decoded.created_at,
  });
}

const CellDbRow = z.object({
  cell_id: z.string(),
  experiment_id: z.string(),
  label: z.string(),
  frozen_config: z.unknown(),
  trials_target: z.number().int(),
});

function decodeCell(row: unknown): ExperimentCellRow {
  const decoded = CellDbRow.parse(row);
  return ExperimentCellRow.parse({
    cellId: decoded.cell_id,
    experimentId: decoded.experiment_id,
    label: decoded.label,
    frozenConfig: FrozenConfig.parse(decoded.frozen_config),
    trialsTarget: decoded.trials_target,
  });
}

// ---- Experiments ----------------------------------------------------------

export interface CreateExperimentInput {
  experimentId: string;
  title: string;
  knob: string;
  hypothesis: string;
  seedTaskRef: SeedTaskRef;
}

/** Insert an experiment under org scope (RLS-enforced via `experiments.org_id`). */
export async function createExperiment(
  pool: pg.Pool,
  orgId: string,
  input: CreateExperimentInput,
): Promise<ExperimentRow> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `INSERT INTO experiments (experiment_id, org_id, title, knob, hypothesis, seed_task_ref)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING experiment_id, org_id, title, knob, hypothesis, seed_task_ref, created_at`,
      [
        input.experimentId,
        orgId,
        input.title,
        input.knob,
        input.hypothesis,
        JSON.stringify(SeedTaskRef.parse(input.seedTaskRef)),
      ],
    );
    return decodeExperiment(result.rows[0]);
  });
}

/** List an org's experiments, newest first. */
export async function listExperiments(pool: pg.Pool, orgId: string): Promise<ExperimentRow[]> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT experiment_id, org_id, title, knob, hypothesis, seed_task_ref, created_at
         FROM experiments
        WHERE org_id = $1
        ORDER BY created_at DESC, experiment_id ASC`,
      [orgId],
    );
    return result.rows.map(decodeExperiment);
  });
}

/** Get one experiment under org scope; throws when invisible (cross-org → zero rows). */
export async function getExperiment(pool: pg.Pool, orgId: string, experimentId: string): Promise<ExperimentRow> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT experiment_id, org_id, title, knob, hypothesis, seed_task_ref, created_at
         FROM experiments WHERE experiment_id = $1`,
      [experimentId],
    );
    if (result.rows[0] === undefined) throw new ExperimentNotFoundError(experimentId);
    return decodeExperiment(result.rows[0]);
  });
}

/**
 * The org that owns an experiment — the bootstrap a route resolves BEFORE any
 * org-scoped work (the worker's job-bootstrap pattern). Reads cross-org via the
 * system scope so an enforced-RLS empty-GUC read does not see zero rows.
 */
export async function loadExperimentOrgId(pool: pg.Pool, experimentId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string }>(`SELECT org_id FROM experiments WHERE experiment_id = $1`, [
      experimentId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

// ---- Cells ----------------------------------------------------------------

export interface CreateCellInput {
  cellId: string;
  label: string;
  frozenConfig: FrozenConfig;
  trialsTarget: number;
}

/**
 * Insert a cell under its experiment, org-scoped. Verifies the parent experiment
 * is visible to the org first (so a cross-org or unknown experiment id fails
 * loudly rather than orphaning a cell). Returns the typed cell row.
 */
export async function createCell(
  pool: pg.Pool,
  orgId: string,
  experimentId: string,
  input: CreateCellInput,
): Promise<ExperimentCellRow> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const parent = await client.query(`SELECT 1 FROM experiments WHERE experiment_id = $1`, [experimentId]);
    if (parent.rows[0] === undefined) throw new ExperimentNotFoundError(experimentId);
    const result = await client.query(
      `INSERT INTO experiment_cells (cell_id, experiment_id, label, frozen_config, trials_target)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING cell_id, experiment_id, label, frozen_config, trials_target`,
      [
        input.cellId,
        experimentId,
        input.label,
        JSON.stringify(FrozenConfig.parse(input.frozenConfig)),
        input.trialsTarget,
      ],
    );
    return decodeCell(result.rows[0]);
  });
}

/** List an experiment's cells in insertion (id) order, org-scoped. */
export async function listCells(pool: pg.Pool, orgId: string, experimentId: string): Promise<ExperimentCellRow[]> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT cell_id, experiment_id, label, frozen_config, trials_target
         FROM experiment_cells WHERE experiment_id = $1 ORDER BY cell_id ASC`,
      [experimentId],
    );
    return result.rows.map(decodeCell);
  });
}

/** Get one cell under org scope; throws when invisible. */
export async function getCell(pool: pg.Pool, orgId: string, cellId: string): Promise<ExperimentCellRow> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT cell_id, experiment_id, label, frozen_config, trials_target
         FROM experiment_cells WHERE cell_id = $1`,
      [cellId],
    );
    if (result.rows[0] === undefined) throw new CellNotFoundError(cellId);
    return decodeCell(result.rows[0]);
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

// ---- Trial scorecards (the cached projection the reducers consume) --------

/**
 * Read a cell's trials' cached `TrialScorecard`s, org-scoped. The scorecard is
 * the projection cached at trial-write time (writeTrialRow); the report surface
 * reduces these via `deriveCellScorecard` / `compareCells` — no re-projection.
 * Throws `CellNotFoundError` when the cell is invisible so a mis-scoped read
 * fails loudly rather than silently reducing an empty sample.
 */
export async function loadCellTrialScorecards(pool: pg.Pool, orgId: string, cellId: string): Promise<TrialScorecard[]> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const cell = await client.query(`SELECT 1 FROM experiment_cells WHERE cell_id = $1`, [cellId]);
    if (cell.rows[0] === undefined) throw new CellNotFoundError(cellId);
    const result = await client.query<{ scorecard: unknown }>(
      `SELECT scorecard FROM experiment_trials WHERE cell_id = $1 ORDER BY trial_index ASC`,
      [cellId],
    );
    return result.rows.map((row) => TrialScorecard.parse(row.scorecard));
  });
}
