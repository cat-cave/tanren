CREATE TABLE "land_group_delivery_loops" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"land_group_id" text NOT NULL,
	"main_sha" text NOT NULL,
	"state" text NOT NULL,
	"disposition" text NOT NULL,
	"artifact_digest" text,
	"preview_release_instance_id" text,
	"production_release_instance_id" text,
	"rollback_release_instance_id" text,
	"attributed_run_id" text,
	"idempotency_key" text NOT NULL,
	"fencing_token" text NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "land_group_delivery_loops_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "land_group_delivery_loops_artifact_digest_check" CHECK ("land_group_delivery_loops"."artifact_digest" IS NULL OR "land_group_delivery_loops"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_land_group_fk" FOREIGN KEY ("org_id","land_group_id") REFERENCES "public"."land_groups"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_preview_release_fk" FOREIGN KEY ("org_id","preview_release_instance_id") REFERENCES "public"."release_instances"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_production_release_fk" FOREIGN KEY ("org_id","production_release_instance_id") REFERENCES "public"."release_instances"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" ADD CONSTRAINT "land_group_delivery_loops_rollback_release_fk" FOREIGN KEY ("org_id","rollback_release_instance_id") REFERENCES "public"."release_instances"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "land_group_delivery_loops_org_land_group_unique" ON "land_group_delivery_loops" USING btree ("org_id","land_group_id");--> statement-breakpoint
CREATE INDEX "land_group_delivery_loops_org_id" ON "land_group_delivery_loops" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "land_group_delivery_loops_org_project" ON "land_group_delivery_loops" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "land_group_delivery_loops" AS PERMISSIVE FOR ALL TO public USING ("land_group_delivery_loops"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("land_group_delivery_loops"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "land_group_delivery_loops" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.land_group.delivery.completed', 'ok'),
  ('merge.land_group.delivery.failed', 'warn')
ON CONFLICT ("name") DO NOTHING;
