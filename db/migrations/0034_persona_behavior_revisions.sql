CREATE TABLE "persona_revisions" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"persona_id" text NOT NULL,
	"scope" text NOT NULL,
	"revision_number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"authoring_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supersedes_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_revisions_id_pk" PRIMARY KEY ("id"),
	CONSTRAINT "persona_revisions_org_id_id_key" UNIQUE ("org_id", "id"),
	CONSTRAINT "persona_revisions_org_persona_revision_number_key" UNIQUE ("org_id", "persona_id", "revision_number"),
	CONSTRAINT "persona_revisions_scope_check" CHECK ("persona_revisions"."scope" IN ('org', 'project')),
	CONSTRAINT "persona_revisions_scope_project_check" CHECK (("persona_revisions"."scope" = 'org' AND "persona_revisions"."project_id" IS NULL) OR ("persona_revisions"."scope" = 'project' AND "persona_revisions"."project_id" IS NOT NULL)),
	CONSTRAINT "persona_revisions_status_check" CHECK ("persona_revisions"."status" IN ('active', 'superseded', 'needs_respec')),
	CONSTRAINT "persona_revisions_content_digest_check" CHECK ("persona_revisions"."content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "persona_revisions_revision_number_check" CHECK ("persona_revisions"."revision_number" >= 1),
	CONSTRAINT "persona_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "persona_revisions_org_supersedes_fk" FOREIGN KEY ("org_id", "supersedes_id") REFERENCES "persona_revisions"("org_id", "id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "persona_revisions_org_id" ON "persona_revisions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "persona_revisions_org_persona_id" ON "persona_revisions" USING btree ("org_id", "persona_id");
--> statement-breakpoint
ALTER TABLE "persona_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "persona_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "persona_revisions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "persona_revisions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "behavior_revisions" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"behavior_id" text NOT NULL,
	"persona_revision_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"given" text NOT NULL,
	"when" text NOT NULL,
	"then" text NOT NULL,
	"acceptance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"design_contract_digest" text,
	"authoring_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supersedes_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "behavior_revisions_id_pk" PRIMARY KEY ("id"),
	CONSTRAINT "behavior_revisions_org_id_id_key" UNIQUE ("org_id", "id"),
	CONSTRAINT "behavior_revisions_org_behavior_revision_number_key" UNIQUE ("org_id", "behavior_id", "revision_number"),
	CONSTRAINT "behavior_revisions_status_check" CHECK ("behavior_revisions"."status" IN ('active', 'superseded', 'needs_respec')),
	CONSTRAINT "behavior_revisions_content_digest_check" CHECK ("behavior_revisions"."content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "behavior_revisions_design_contract_digest_check" CHECK ("behavior_revisions"."design_contract_digest" IS NULL OR "behavior_revisions"."design_contract_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "behavior_revisions_revision_number_check" CHECK ("behavior_revisions"."revision_number" >= 1),
	CONSTRAINT "behavior_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "behavior_revisions_org_persona_revision_fk" FOREIGN KEY ("org_id", "persona_revision_id") REFERENCES "persona_revisions"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "behavior_revisions_org_supersedes_fk" FOREIGN KEY ("org_id", "supersedes_id") REFERENCES "behavior_revisions"("org_id", "id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "behavior_revisions_org_id" ON "behavior_revisions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "behavior_revisions_org_behavior_id" ON "behavior_revisions" USING btree ("org_id", "behavior_id");
--> statement-breakpoint
ALTER TABLE "behavior_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "behavior_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "behavior_revisions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "behavior_revisions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
