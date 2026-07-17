-- Wave-3 barrier: issue-loop provenance and task/cost scope are first-class.
CREATE TABLE "spec_origins" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "spec_id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "triage_task_id" text NOT NULL,
  "attempt_number" integer NOT NULL,
  "role" text NOT NULL,
  "ordinal" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spec_origins_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "spec_origins_attempt_role_ordinal_unique" UNIQUE("org_id","issue_loop_id","attempt_number","role","ordinal"),
  CONSTRAINT "spec_origins_role_check" CHECK ("spec_origins"."role" IN ('primary_fix','repair','rollback','probe_capability','followup'))
);
--> statement-breakpoint
CREATE TABLE "spec_origin_findings" (
  "org_id" text NOT NULL,
  "spec_id" text NOT NULL,
  "source_finding_id" text NOT NULL,
  CONSTRAINT "spec_origin_findings_org_id_spec_id_source_finding_id_pk" PRIMARY KEY("org_id","spec_id","source_finding_id")
);
--> statement-breakpoint
ALTER TABLE "spec_origins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spec_origins" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spec_origin_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spec_origin_findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "spec_origins_org_id" ON "spec_origins" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "spec_origin_findings_org_id" ON "spec_origin_findings" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "spec_origins" ADD CONSTRAINT "spec_origins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origins" ADD CONSTRAINT "spec_origins_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origins" ADD CONSTRAINT "spec_origins_spec_lineage_fk" FOREIGN KEY ("org_id","project_id","spec_id") REFERENCES "public"."specs"("org_id","project_id","spec_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origins" ADD CONSTRAINT "spec_origins_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origin_findings" ADD CONSTRAINT "spec_origin_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origin_findings" ADD CONSTRAINT "spec_origin_findings_spec_fk" FOREIGN KEY ("org_id","spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spec_origin_findings" ADD CONSTRAINT "spec_origin_findings_source_finding_fk" FOREIGN KEY ("org_id","source_finding_id") REFERENCES "public"."source_findings"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "origin_issue_loop_id" text;
--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_origin_issue_loop_fk" FOREIGN KEY ("org_id","origin_issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "issue_loop_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_or_issue_loop_check" CHECK (("tasks"."run_id" IS NOT NULL) <> ("tasks"."issue_loop_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_records" ADD COLUMN "issue_loop_id" text;
--> statement-breakpoint
ALTER TABLE "cost_records" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_run_or_issue_loop_check" CHECK (("cost_records"."run_id" IS NOT NULL) <> ("cost_records"."issue_loop_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "spec_origins";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "spec_origins" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "spec_origin_findings";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "spec_origin_findings" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
