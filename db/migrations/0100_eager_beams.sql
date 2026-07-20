CREATE TABLE "merge_eager_beams" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"frontier_run_id" text NOT NULL,
	"frontier_spec_id" text NOT NULL,
	"plan_digest" text,
	"integration_node_id" text,
	"rank" integer NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"stale_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_eager_beams_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_eager_beams_rank_check" CHECK ("merge_eager_beams"."rank" >= 1),
	CONSTRAINT "merge_eager_beams_generation_check" CHECK ("merge_eager_beams"."generation" >= 1),
	CONSTRAINT "merge_eager_beams_state_check" CHECK ("merge_eager_beams"."state" IN ('building','ready','stale','held')),
	CONSTRAINT "merge_eager_beams_complete_plan_check" CHECK (("merge_eager_beams"."state" IN ('held') AND "merge_eager_beams"."plan_digest" IS NULL AND "merge_eager_beams"."integration_node_id" IS NULL) OR ("merge_eager_beams"."plan_digest" IS NOT NULL AND "merge_eager_beams"."integration_node_id" IS NOT NULL)),
	CONSTRAINT "merge_eager_beams_stale_reason_check" CHECK (("merge_eager_beams"."state" IN ('stale','held') AND "merge_eager_beams"."stale_reason" IS NOT NULL) OR ("merge_eager_beams"."state" IN ('building','ready') AND "merge_eager_beams"."stale_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_nodes" DROP CONSTRAINT "integration_nodes_purpose_check";--> statement-breakpoint
CREATE UNIQUE INDEX "integration_nodes_org_node_unique" ON "integration_nodes" USING btree ("org_id","node_id");--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_frontier_run_fk" FOREIGN KEY ("org_id","frontier_run_id") REFERENCES "public"."runs"("org_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_frontier_spec_fk" FOREIGN KEY ("org_id","frontier_spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_plan_cas_fk" FOREIGN KEY ("org_id","plan_digest") REFERENCES "public"."cas_artifacts"("org_id","digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_eager_beams" ADD CONSTRAINT "merge_eager_beams_integration_node_fk" FOREIGN KEY ("org_id","integration_node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_eager_beams_org_plan_digest_unique" ON "merge_eager_beams" USING btree ("org_id","plan_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_eager_beams_org_frontier_held_unique" ON "merge_eager_beams" USING btree ("org_id","frontier_run_id") WHERE "merge_eager_beams"."plan_digest" IS NULL;--> statement-breakpoint
CREATE INDEX "merge_eager_beams_org_project" ON "merge_eager_beams" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_purpose_check" CHECK ("integration_nodes"."purpose" IN ('eager_base','eager_beam','merge_batch','stack_head','bisect_prefix','pre_merge_preview'));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_eager_beams" AS PERMISSIVE FOR ALL TO public USING ("merge_eager_beams"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_eager_beams"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.beam.planned', 'info'),
  ('merge.beam.stale', 'warn')
ON CONFLICT ("name") DO NOTHING;
