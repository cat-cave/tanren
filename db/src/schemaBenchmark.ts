// Tanren-method benchmark entities (docs/roadmap/tanren-method-benchmark.md
// §4.2). A THIN indexing layer over the existing run/event/cost data plane —
// NOT a parallel run store. `experiment_trials` joins a benchmark observation
// onto a real `runs` row; the heavy data stays in runs/cost_records/events.
// All three are tenant tables: `experiments` carries org_id directly; the two
// children derive their org via their parent (RLS policies in migration 0033).
//
// Kept in its own sub-schema file (re-exported by schema.ts) to respect the
// file-line-max-500 architecture rule. The cross-file references —
// `experiments.org_id → organizations` and `experiment_trials.run_id → runs` —
// both resolve from schemaCore.js, so this sub-schema never imports schema.ts
// (schema.ts re-exports the sub-schemas; importing it back would close an
// import cycle the lint `no-cycle` rule rejects).

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, runs } from "./schemaCore.js";

export const experiments = pgTable(
  "experiments",
  {
    experimentId: text("experiment_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    // The single dimension varied across this experiment's cells (the §3.3
    // one-knob invariant): e.g. "gate_strictness" / "model_cost" / "checker".
    knob: text("knob").notNull(),
    hypothesis: text("hypothesis").notNull(),
    // The pinned seed task: repo + SHA + the content-addressed hidden accept-tier
    // hash (§3.1). JSONB so the shape can grow without a migration.
    seedTaskRef: jsonb("seed_task_ref")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("experiments_org_id").on(table.orgId)],
);

export const experimentCells = pgTable(
  "experiment_cells",
  {
    cellId: text("cell_id").primaryKey(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiments.experimentId),
    label: text("label").notNull(),
    // The frozen `(RoutingTable + EscapeHatches + tanren-ci tier snapshot +
    // governance posture)` config point (§3.1). JSONB — the cell holds the whole
    // config so a trial is reproducible from the row alone.
    frozenConfig: jsonb("frozen_config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    trialsTarget: integer("trials_target").notNull(),
  },
  (table) => [
    check("experiment_cells_trials_target_check", sql`${table.trialsTarget} >= 1`),
    index("experiment_cells_experiment_id").on(table.experimentId),
  ],
);

export const experimentTrials = pgTable(
  "experiment_trials",
  {
    trialId: text("trial_id").primaryKey(),
    cellId: text("cell_id")
      .notNull()
      .references(() => experimentCells.cellId),
    // The real run that backs this trial (the join into the data plane).
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    trialIndex: integer("trial_index").notNull(),
    // The post-merge hidden accept-tier outcome (§2.1). Nullable: the accept
    // step is a follow-up, so a trial may exist before its accept result lands.
    acceptResult: text("accept_result"),
    // The projected `TrialScorecard` (§2.3). JSONB — derived, cached per trial.
    scorecard: jsonb("scorecard")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    check(
      "experiment_trials_accept_result_check",
      sql`${table.acceptResult} IS NULL OR ${table.acceptResult} IN ('passed','failed')`,
    ),
    uniqueIndex("experiment_trials_run_unique").on(table.runId),
    uniqueIndex("experiment_trials_cell_index_unique").on(table.cellId, table.trialIndex),
    index("experiment_trials_cell_id").on(table.cellId),
  ],
);
