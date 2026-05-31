CREATE TABLE "experiment_cells" (
	"cell_id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"label" text NOT NULL,
	"frozen_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trials_target" integer NOT NULL,
	CONSTRAINT "experiment_cells_trials_target_check" CHECK ("experiment_cells"."trials_target" >= 1)
);
--> statement-breakpoint
CREATE TABLE "experiment_trials" (
	"trial_id" text PRIMARY KEY NOT NULL,
	"cell_id" text NOT NULL,
	"run_id" text NOT NULL,
	"trial_index" integer NOT NULL,
	"accept_result" text,
	"scorecard" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "experiment_trials_accept_result_check" CHECK ("experiment_trials"."accept_result" IS NULL OR "experiment_trials"."accept_result" IN ('passed','failed'))
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"experiment_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"knob" text NOT NULL,
	"hypothesis" text NOT NULL,
	"seed_task_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_cells" ADD CONSTRAINT "experiment_cells_experiment_id_experiments_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("experiment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_cell_id_experiment_cells_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."experiment_cells"("cell_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiment_cells_experiment_id" ON "experiment_cells" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_trials_run_unique" ON "experiment_trials" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_trials_cell_index_unique" ON "experiment_trials" USING btree ("cell_id","trial_index");--> statement-breakpoint
CREATE INDEX "experiment_trials_cell_id" ON "experiment_trials" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "experiments_org_id" ON "experiments" USING btree ("org_id");--> statement-breakpoint

-- RLS for the benchmark entities, mirroring migration 0030's deny-by-default
-- pattern. `experiments` keys directly on org_id (3a-style direct policy); the
-- two children have NO own org_id and are scoped through their parent chain
-- (3c-style EXISTS subquery): a cell via its experiment, a trial via its cell's
-- experiment. The EXISTS subquery runs under the SAME `app.current_org_id` GUC,
-- so it resolves the parent only when the parent belongs to the scoped org —
-- making a cross-org cell/trial both unreadable AND unwritable. Idempotent via
-- DROP POLICY IF EXISTS so re-running the full migration set never errors.
ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON experiments;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON experiments FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));--> statement-breakpoint

ALTER TABLE experiment_cells ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON experiment_cells;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON experiment_cells FOR ALL
  USING (EXISTS (SELECT 1 FROM experiments e WHERE e.experiment_id = experiment_cells.experiment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM experiments e WHERE e.experiment_id = experiment_cells.experiment_id));--> statement-breakpoint

ALTER TABLE experiment_trials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON experiment_trials;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON experiment_trials FOR ALL
  USING (EXISTS (SELECT 1 FROM experiment_cells c WHERE c.cell_id = experiment_trials.cell_id))
  WITH CHECK (EXISTS (SELECT 1 FROM experiment_cells c WHERE c.cell_id = experiment_trials.cell_id));
