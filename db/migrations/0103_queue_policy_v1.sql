CREATE TABLE "merge_queue_commands" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"command" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"scope_target_branch" text,
	"scope_queue_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_commands_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_queue_commands_command_check" CHECK ("merge_queue_commands"."command" IN ('queue','requeue','dequeue','refresh','boost','clear-boost','pause','resume','freeze','unfreeze','drain'))
);
--> statement-breakpoint
ALTER TABLE "merge_queue_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merge_queue_policies" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"target_branch" text NOT NULL,
	"version" integer NOT NULL,
	"schema_version" text NOT NULL,
	"body" jsonb NOT NULL,
	"compiled_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"supersedes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_policies_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_queue_policies_schema_version_check" CHECK ("merge_queue_policies"."schema_version" = 'queue_policy.v1')
);
--> statement-breakpoint
ALTER TABLE "merge_queue_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merge_queue_windows" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"policy_id" text NOT NULL,
	"project_id" text NOT NULL,
	"target_branch" text,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"intervals" jsonb NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_windows_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_queue_windows_kind_check" CHECK ("merge_queue_windows"."kind" IN ('allow','blackout'))
);
--> statement-breakpoint
ALTER TABLE "merge_queue_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_queue" DROP CONSTRAINT "merge_queue_status_check";--> statement-breakpoint
DROP INDEX "merge_queue_active_run_unique";--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "route_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "priority_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "priority_override" text;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "policy_hold_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_org_queue_unique" ON "merge_queue" USING btree ("org_id","queue_id");--> statement-breakpoint
ALTER TABLE "merge_queue_commands" ADD CONSTRAINT "merge_queue_commands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_commands" ADD CONSTRAINT "merge_queue_commands_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_commands" ADD CONSTRAINT "merge_queue_commands_policy_fk" FOREIGN KEY ("org_id","policy_id") REFERENCES "public"."merge_queue_policies"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_commands" ADD CONSTRAINT "merge_queue_commands_queue_fk" FOREIGN KEY ("org_id","scope_queue_id") REFERENCES "public"."merge_queue"("org_id","queue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_policies" ADD CONSTRAINT "merge_queue_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_policies" ADD CONSTRAINT "merge_queue_policies_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_policies" ADD CONSTRAINT "merge_queue_policies_supersedes_fk" FOREIGN KEY ("org_id","supersedes") REFERENCES "public"."merge_queue_policies"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_windows" ADD CONSTRAINT "merge_queue_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_windows" ADD CONSTRAINT "merge_queue_windows_policy_fk" FOREIGN KEY ("org_id","policy_id") REFERENCES "public"."merge_queue_policies"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_windows" ADD CONSTRAINT "merge_queue_windows_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_commands_idempotency_unique" ON "merge_queue_commands" USING btree ("org_id","project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "merge_queue_commands_org_project_created" ON "merge_queue_commands" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_policies_org_version_unique" ON "merge_queue_policies" USING btree ("org_id","project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_policies_active_unique" ON "merge_queue_policies" USING btree ("org_id","project_id") WHERE "merge_queue_policies"."active" = true;--> statement-breakpoint
CREATE INDEX "merge_queue_policies_org_project" ON "merge_queue_policies" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_windows_policy_name_unique" ON "merge_queue_windows" USING btree ("org_id","policy_id","name");--> statement-breakpoint
CREATE INDEX "merge_queue_windows_org_project" ON "merge_queue_windows" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_active_run_unique" ON "merge_queue" USING btree ("run_id") WHERE status IN ('queued', 'merging', 'parked_grant', 'held_policy');--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_policy_hold_reason_check" CHECK ("merge_queue"."policy_hold_reason" IS NULL OR "merge_queue"."status" = 'held_policy');--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_status_check" CHECK ("merge_queue"."status" IN ('queued','merging','merged','dequeued','parked_grant','held_policy'));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_queue_commands" AS PERMISSIVE FOR ALL TO public USING ("merge_queue_commands"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_queue_commands"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_queue_policies" AS PERMISSIVE FOR ALL TO public USING ("merge_queue_policies"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_queue_policies"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_queue_windows" AS PERMISSIVE FOR ALL TO public USING ("merge_queue_windows"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_queue_windows"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "merge_queue_commands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_queue_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_queue_windows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.policy.revised', 'info'),
  ('merge.queue.command_applied', 'info'),
  ('merge.queue.window_changed', 'info'),
  ('merge.queue.admission_held', 'warn')
ON CONFLICT ("name") DO NOTHING;
