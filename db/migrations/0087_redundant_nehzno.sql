CREATE TABLE "design_render_land_verdicts" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"release_id" text NOT NULL,
	"design_contract_version" text NOT NULL,
	"accessibility_standard" text NOT NULL,
	"outcome" text NOT NULL,
	"checkpoint_count" integer NOT NULL,
	"passed_count" integer NOT NULL,
	"failed_count" integer NOT NULL,
	"inconclusive_count" integer NOT NULL,
	"excluded_count" integer NOT NULL,
	"failing_scenario_key" text,
	"failing_rule_ids" jsonb NOT NULL,
	"checkpoints" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_render_land_verdicts_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_render_land_verdicts_outcome_check" CHECK ("design_render_land_verdicts"."outcome" IN ('passed','failed_visual','inconclusive_infrastructure','not_applicable')),
	CONSTRAINT "design_render_land_verdicts_checkpoint_count_check" CHECK ("design_render_land_verdicts"."checkpoint_count" >= 0),
	CONSTRAINT "design_render_land_verdicts_passed_count_check" CHECK ("design_render_land_verdicts"."passed_count" >= 0),
	CONSTRAINT "design_render_land_verdicts_failed_count_check" CHECK ("design_render_land_verdicts"."failed_count" >= 0),
	CONSTRAINT "design_render_land_verdicts_inconclusive_count_check" CHECK ("design_render_land_verdicts"."inconclusive_count" >= 0),
	CONSTRAINT "design_render_land_verdicts_excluded_count_check" CHECK ("design_render_land_verdicts"."excluded_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "design_render_land_verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_render_land_verdicts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_render_land_verdicts" ADD CONSTRAINT "design_render_land_verdicts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_render_land_verdicts" ADD CONSTRAINT "design_render_land_verdicts_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_render_land_verdicts_org_id" ON "design_render_land_verdicts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "design_render_land_verdicts_org_project" ON "design_render_land_verdicts" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_render_land_verdicts" AS PERMISSIVE FOR ALL TO public USING ("design_render_land_verdicts"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_render_land_verdicts"."org_id" = current_setting('app.current_org_id', true));
