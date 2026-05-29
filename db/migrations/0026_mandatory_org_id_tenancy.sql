-- Mandatory tenant isolation: org_id becomes a first-class, NOT NULL, indexed
-- column on the core run-execution tables (tanren SaaS Tier-A hardening).
--
-- SAFE ordering for a populated database:
--   1. add org_id NULLABLE on each core table,
--   2. backfill it (projects from their org; everything else down the
--      project_id / run_id chain),
--   3. tighten projects.org_id and every new column to NOT NULL,
--   4. add the FK + index/composite-index set,
--   5. drop the now-redundant nullable tenant_id columns.
--
-- BACKFILL CAVEAT: the backfill derives org_id through project_id ->
-- projects.org_id (and run_id -> runs.org_id). A legacy dev DB whose projects
-- still carry a NULL org_id cannot be backfilled and the SET NOT NULL in step 3
-- will (correctly) fail until those rows are assigned an org. On a fresh DB
-- there are no rows, so every statement is a no-op and the schema is created
-- correctly. The route/loader layer already refuses null-org access, so any
-- such legacy rows were unreachable.

-- 1. Add org_id as NULLABLE so existing rows survive the ADD COLUMN.
ALTER TABLE "cost_records" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "org_id" text;--> statement-breakpoint

-- 2. Backfill down the ownership chain. projects.org_id is the root and is
-- already present; specs/runs derive from their project, tasks/cost_records
-- /runners derive from their run, events derive from their project.
UPDATE "specs" s SET "org_id" = p."org_id" FROM "projects" p WHERE p."project_id" = s."project_id" AND s."org_id" IS NULL;--> statement-breakpoint
UPDATE "runs" r SET "org_id" = p."org_id" FROM "projects" p WHERE p."project_id" = r."project_id" AND r."org_id" IS NULL;--> statement-breakpoint
UPDATE "tasks" t SET "org_id" = r."org_id" FROM "runs" r WHERE r."run_id" = t."run_id" AND t."org_id" IS NULL;--> statement-breakpoint
UPDATE "cost_records" c SET "org_id" = r."org_id" FROM "runs" r WHERE r."run_id" = c."run_id" AND c."org_id" IS NULL;--> statement-breakpoint
UPDATE "runners" rn SET "org_id" = r."org_id" FROM "runs" r WHERE r."run_id" = rn."run_id" AND rn."org_id" IS NULL;--> statement-breakpoint
UPDATE "runners" rn SET "org_id" = p."org_id" FROM "projects" p WHERE p."project_id" = rn."project_id" AND rn."org_id" IS NULL;--> statement-breakpoint
UPDATE "events" e SET "org_id" = p."org_id" FROM "projects" p WHERE p."project_id" = e."project_id" AND e."org_id" IS NULL;--> statement-breakpoint

-- 3. Tighten to NOT NULL now that every row carries an org. projects.org_id is
-- the chain root and is enforced first.
ALTER TABLE "projects" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_records" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "specs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- 4. Foreign keys + indexes (single-column and the composite indexes the
-- run/event/cost loaders filter on).
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_records_org_id" ON "cost_records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cost_records_org_run" ON "cost_records" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "events_org_id" ON "events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "events_org_run_ts" ON "events" USING btree ("org_id","run_id","ts");--> statement-breakpoint
CREATE INDEX "events_org_project_ts" ON "events" USING btree ("org_id","project_id","ts");--> statement-breakpoint
CREATE INDEX "projects_org_id" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runners_org_id" ON "runners" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runs_org_id" ON "runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runs_org_run" ON "runs" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "runs_org_project" ON "runs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "specs_org_id" ON "specs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tasks_org_id" ON "tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tasks_org_run" ON "tasks" USING btree ("org_id","run_id");--> statement-breakpoint

-- 5. Drop the redundant nullable tenant_id columns (reconciled into org_id).
ALTER TABLE "cost_records" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "runners" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "specs" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "tenant_id";
