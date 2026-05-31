// Benchmark report/CRUD HTTP surface (docs/roadmap/tanren-method-benchmark.md
// §4.2 item 4). Org-scoped, RLS-enforced operator routes to author experiments +
// cells, trigger a benchmark run (the existing `runExperiment`/`runExperimentCell`
// scheduler), and READ cell-vs-cell results (the `deriveCellScorecard` /
// `compareCells` reducers over each cell's cached `TrialScorecard`s). No new run
// history store: trials live in `experiment_trials`, projected scorecards are
// cached per-trial, and these routes only reduce them. The runner seam is
// injectable so the route layer is testable without a live worker.

import { randomUUID } from "node:crypto";
import { type Context, Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { FrozenConfig, SeedTaskRef } from "../../engine/benchmark/entities.js";
import {
  compareCells,
  deriveCellScorecard,
  OneKnobViolationError,
} from "../../engine/benchmark/reducers.js";
import {
  runExperiment as defaultRunExperiment,
  runExperimentCell as defaultRunExperimentCell,
  type CellRunResult,
  type ExperimentRunResult,
} from "../../engine/benchmark/runner.js";
import {
  CellNotFoundError,
  createCell,
  createExperiment,
  ExperimentNotFoundError,
  getCell,
  getExperiment,
  listCells,
  listExperiments,
  loadCellTrialScorecards,
} from "../../engine/benchmark/store.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface ExperimentRoutesOptions {
  pool: pg.Pool;
  /** Inject the benchmark scheduler (defaults to the real runner). */
  runExperiment?: (pool: pg.Pool, experimentId: string) => Promise<ExperimentRunResult>;
  runExperimentCell?: (pool: pg.Pool, cellId: string) => Promise<CellRunResult>;
}

const CreateExperimentBody = z
  .object({
    title: z.string().min(1),
    knob: z.string().min(1),
    hypothesis: z.string().min(1),
    seedTaskRef: SeedTaskRef,
  })
  .strict();

const CreateCellBody = z
  .object({
    label: z.string().min(1),
    frozenConfig: FrozenConfig,
    trialsTarget: z.number().int().min(1),
  })
  .strict();

export function createExperimentRoutes(options: ExperimentRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const pool = options.pool;
  const runExperiment = options.runExperiment ?? ((p, id) => defaultRunExperiment({ pool: p }, id));
  const runExperimentCell = options.runExperimentCell ?? ((p, id) => defaultRunExperimentCell({ pool: p }, id));

  // ---- Experiments ----
  app.post("/:orgId/experiments", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const parsed = CreateExperimentBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid_experiment", issues: parsed.error.issues }, 400);
    try {
      const experiment = await createExperiment(pool, orgId, {
        experimentId: `experiment_${randomUUID()}`,
        ...parsed.data,
      });
      return c.json({ experiment }, 201);
    } catch (error) {
      return c.json({ error: "experiment_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/experiments", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    return c.json({ experiments: await listExperiments(pool, orgId) });
  });

  app.get("/:orgId/experiments/:experimentId", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const experimentId = c.req.param("experimentId");
    try {
      return c.json({ experiment: await getExperiment(pool, orgId, experimentId) });
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) return c.json({ error: "experiment_not_found" }, 404);
      throw error;
    }
  });

  // ---- Cells ----
  app.post("/:orgId/experiments/:experimentId/cells", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const experimentId = c.req.param("experimentId");
    const parsed = CreateCellBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid_cell", issues: parsed.error.issues }, 400);
    try {
      const cell = await createCell(pool, orgId, experimentId, { cellId: `cell_${randomUUID()}`, ...parsed.data });
      return c.json({ cell }, 201);
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) return c.json({ error: "experiment_not_found" }, 404);
      return c.json({ error: "cell_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/experiments/:experimentId/cells", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const experimentId = c.req.param("experimentId");
    return c.json({ cells: await listCells(pool, orgId, experimentId) });
  });

  app.get("/:orgId/cells/:cellId", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const cellId = c.req.param("cellId");
    try {
      return c.json({ cell: await getCell(pool, orgId, cellId) });
    } catch (error) {
      if (error instanceof CellNotFoundError) return c.json({ error: "cell_not_found" }, 404);
      throw error;
    }
  });

  // ---- Run ----
  app.post("/:orgId/experiments/:experimentId/run", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const experimentId = c.req.param("experimentId");
    try {
      // Authorize the experiment is visible to this org before scheduling.
      await getExperiment(pool, orgId, experimentId);
      return c.json({ result: await runExperiment(pool, experimentId) });
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) return c.json({ error: "experiment_not_found" }, 404);
      return c.json({ error: "experiment_run_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/cells/:cellId/run", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const cellId = c.req.param("cellId");
    try {
      await getCell(pool, orgId, cellId);
      return c.json({ result: await runExperimentCell(pool, cellId) });
    } catch (error) {
      if (error instanceof CellNotFoundError) return c.json({ error: "cell_not_found" }, 404);
      return c.json({ error: "cell_run_failed", message: messageOf(error) }, 500);
    }
  });

  // ---- Report (cell scorecard) ----
  app.get("/:orgId/cells/:cellId/scorecard", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const cellId = c.req.param("cellId");
    try {
      const trials = await loadCellTrialScorecards(pool, orgId, cellId);
      return c.json({ scorecard: deriveCellScorecard(trials) });
    } catch (error) {
      if (error instanceof CellNotFoundError) return c.json({ error: "cell_not_found" }, 404);
      throw error;
    }
  });

  // ---- Compare (cell vs cell, one-knob enforced) ----
  app.get("/:orgId/experiments/:experimentId/compare", async (c) => {
    const { orgId, denied } = gate(c);
    if (denied) return denied;
    const experimentId = c.req.param("experimentId");
    const cellAId = c.req.query("cellA");
    const cellBId = c.req.query("cellB");
    if (cellAId === undefined || cellBId === undefined) {
      return c.json({ error: "missing_cells", message: "cellA and cellB query params are required" }, 400);
    }
    try {
      const [cellA, cellB] = await Promise.all([getCell(pool, orgId, cellAId), getCell(pool, orgId, cellBId)]);
      if (cellA.experimentId !== experimentId || cellB.experimentId !== experimentId) {
        return c.json({ error: "cell_not_in_experiment" }, 400);
      }
      const [trialsA, trialsB] = await Promise.all([
        loadCellTrialScorecards(pool, orgId, cellAId),
        loadCellTrialScorecards(pool, orgId, cellBId),
      ]);
      const comparison = compareCells(trialsA, trialsB, {
        configA: cellA.frozenConfig,
        configB: cellB.frozenConfig,
      });
      return c.json({ cellA: cellAId, cellB: cellBId, comparison });
    } catch (error) {
      if (error instanceof CellNotFoundError) return c.json({ error: "cell_not_found" }, 404);
      if (error instanceof OneKnobViolationError) {
        return c.json({ error: "one_knob_violation", message: error.message, differingKeys: error.differingKeys }, 422);
      }
      throw error;
    }
  });

  return app;
}

interface Gate {
  orgId: string;
  denied: Response | undefined;
}

/** Resolve the actor + org param and deny cross-org access (the shared route guard). */
function gate(c: Context<ActorContextEnv>): Gate {
  const actor = c.var.actor;
  if (actor === undefined) throw new Error("actor missing on context");
  const orgId = c.req.param("orgId") ?? "";
  if (!actorCanAccessOrg(actor, orgId)) {
    return { orgId, denied: c.json({ error: "org_access_denied" }, 403) };
  }
  return { orgId, denied: undefined };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
