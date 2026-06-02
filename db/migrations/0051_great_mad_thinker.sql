CREATE TABLE "org_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"credential_ref" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'linked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_integrations_status_check" CHECK ("org_integrations"."status" IN ('linked','provisioning','error'))
);
--> statement-breakpoint
CREATE TABLE "project_app_env" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"value_ref" text,
	"plain_value" text,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source" text DEFAULT 'byo' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_app_env_source_check" CHECK ("project_app_env"."source" IN ('byo','provisioned')),
	CONSTRAINT "project_app_env_value_xor_check" CHECK (("project_app_env"."value_ref" IS NOT NULL AND "project_app_env"."plain_value" IS NULL) OR ("project_app_env"."value_ref" IS NULL AND "project_app_env"."plain_value" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app_env" ADD CONSTRAINT "project_app_env_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_integrations_org_provider_unique" ON "org_integrations" USING btree ("org_id","provider_kind");--> statement-breakpoint
CREATE INDEX "org_integrations_org_id" ON "org_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_app_env_project_key_unique" ON "project_app_env" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "project_app_env_project_id" ON "project_app_env" USING btree ("project_id");--> statement-breakpoint

-- RLS for the integration-provisioning foundation, mirroring the deny-by-default
-- pattern of migrations 0030/0033/0049.
--
-- `org_integrations` carries its OWN org_id, so it uses the 3a-style DIRECT org
-- match (a row is readable/writable only under its own org's scope) — exactly like
-- `experiments` (0033) and `post_merge_issue_claims` (0049).
--
-- `project_app_env` has NO own org_id; it is scoped through its project's org via
-- the 3c-style project→org EXISTS chain (like `milestones`/`project_members` in
-- 0030). The EXISTS subquery resolves the parent `projects` row, which is ITSELF
-- RLS-scoped on org_id under the SAME `app.current_org_id` GUC — so a row is
-- readable/writable only when its project belongs to the scoped org, making a
-- cross-org app-env row both unreadable AND unwritable.
--
-- Both tables are created by the `tanren` owner role, so they inherit the runtime
-- grants via the `ALTER DEFAULT PRIVILEGES FOR ROLE tanren` set in migrations 0029
-- (tanren_app: SELECT/INSERT/UPDATE/DELETE) and 0031 (tanren_dataplane: same) — no
-- explicit GRANT is needed here (matching 0033/0049). Idempotent via DROP POLICY
-- IF EXISTS so re-running the full migration set never errors.
ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON org_integrations;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON org_integrations FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));--> statement-breakpoint

ALTER TABLE project_app_env ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON project_app_env;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON project_app_env FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_app_env.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_app_env.project_id));
