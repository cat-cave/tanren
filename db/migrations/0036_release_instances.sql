CREATE TABLE "release_instances" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"app_id" text NOT NULL,
	"environment" text NOT NULL,
	"deployment_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"provider_checksum" text,
	"integration_node_id" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"region" text,
	"previous_release_instance_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_instances_artifact_digest_check" CHECK ("release_instances"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "release_instances_provider_checksum_check" CHECK ("release_instances"."provider_checksum" IS NULL OR "release_instances"."provider_checksum" ~ '^sha512:[0-9a-f]{128}$'),
	CONSTRAINT "release_instances_environment_check" CHECK ("release_instances"."environment" IN ('preview', 'production')),
	CONSTRAINT "release_instances_state_check" CHECK ("release_instances"."state" IN ('built', 'preview', 'promoting', 'live', 'superseded', 'rolled_back', 'torn_down', 'failed')),
	CONSTRAINT "release_instances_not_self_check" CHECK ("release_instances"."previous_release_instance_id" IS NULL OR "release_instances"."previous_release_instance_id" <> "release_instances"."id"),
	CONSTRAINT "release_instances_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "release_instances_org_deployment_unique" UNIQUE ("org_id", "provider", "app_id", "deployment_id"),
	CONSTRAINT "release_instances_artifact_cas_artifact_fk" FOREIGN KEY ("org_id", "artifact_digest") REFERENCES "cas_artifacts"("org_id", "digest") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "release_instances_org_previous_fk" FOREIGN KEY ("org_id", "previous_release_instance_id") REFERENCES "release_instances"("org_id", "id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "release_instances" ADD CONSTRAINT "release_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_instances" ADD CONSTRAINT "release_instances_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "release_instances_org_id" ON "release_instances" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "release_instances_org_project" ON "release_instances" USING btree ("org_id", "project_id");
--> statement-breakpoint
CREATE INDEX "release_instances_org_integration_node" ON "release_instances" USING btree ("org_id", "integration_node_id");
--> statement-breakpoint
ALTER TABLE "release_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "release_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "release_instances";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "release_instances" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "release_instance_behavior_revisions" (
	"org_id" text NOT NULL,
	"release_instance_id" text NOT NULL,
	"behavior_revision_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "release_instance_behavior_revisions_pk" PRIMARY KEY ("org_id", "release_instance_id", "behavior_revision_id"),
	CONSTRAINT "release_instance_behavior_revisions_org_release_ordinal_unique" UNIQUE ("org_id", "release_instance_id", "ordinal"),
	CONSTRAINT "release_instance_behavior_revisions_release_fk" FOREIGN KEY ("org_id", "release_instance_id") REFERENCES "release_instances"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "release_instance_behavior_revisions_behavior_revision_fk" FOREIGN KEY ("org_id", "behavior_revision_id") REFERENCES "behavior_revisions"("org_id", "id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "release_instance_behavior_revisions_org_id" ON "release_instance_behavior_revisions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "release_instance_behavior_revisions_org_behavior" ON "release_instance_behavior_revisions" USING btree ("org_id", "behavior_revision_id");
--> statement-breakpoint
ALTER TABLE "release_instance_behavior_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "release_instance_behavior_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "release_instance_behavior_revisions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "release_instance_behavior_revisions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
