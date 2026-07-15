CREATE TABLE "gate_proof_bundles" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"proof_bundle_id" text NOT NULL,
	"gate_verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_proof_bundles_gate_verdict_check" CHECK ("gate_proof_bundles"."gate_verdict" IN ('passed', 'failed', 'unknown')),
	CONSTRAINT "gate_proof_bundles_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "gate_proof_bundles_org_id_proof_bundle_id_unique" UNIQUE ("org_id", "proof_bundle_id"),
	CONSTRAINT "gate_proof_bundles_org_id_id_proof_bundle_id_unique" UNIQUE ("org_id", "id", "proof_bundle_id"),
	CONSTRAINT "gate_proof_bundles_proof_bundle_fk" FOREIGN KEY ("org_id", "proof_bundle_id") REFERENCES "proof_bundles"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "gate_proof_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "gate_proof_bundles_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "gate_proof_bundles_org_id" ON "gate_proof_bundles" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "gate_proof_bundles_org_project" ON "gate_proof_bundles" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "gate_proof_bundles";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "gate_proof_bundles" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "gate_proof_bundle_sections" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"gate_proof_bundle_id" text NOT NULL,
	"proof_bundle_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"section_kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"required" boolean NOT NULL,
	CONSTRAINT "gate_proof_bundle_sections_section_kind_check" CHECK ("gate_proof_bundle_sections"."section_kind" IN ('native_ci', 'runtime_behavior', 'design_render', 'artifact_provenance')),
	CONSTRAINT "gate_proof_bundle_sections_proof_unit_digest_check" CHECK ("gate_proof_bundle_sections"."proof_unit_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "gate_proof_bundle_sections_org_id_bundle_id_unit_pk" PRIMARY KEY ("org_id", "gate_proof_bundle_id", "proof_unit_digest"),
	CONSTRAINT "gate_proof_bundle_sections_org_bundle_ordinal_unique" UNIQUE ("org_id", "gate_proof_bundle_id", "ordinal"),
	CONSTRAINT "gate_proof_bundle_sections_gate_bundle_fk" FOREIGN KEY ("org_id", "gate_proof_bundle_id", "proof_bundle_id") REFERENCES "gate_proof_bundles"("org_id", "id", "proof_bundle_id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "gate_proof_bundle_sections_bundle_unit_fk" FOREIGN KEY ("org_id", "proof_bundle_id", "proof_unit_digest") REFERENCES "proof_bundle_units"("org_id", "bundle_id", "proof_unit_digest") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "gate_proof_bundle_sections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "gate_proof_bundle_sections_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "gate_proof_bundle_sections_org_id" ON "gate_proof_bundle_sections" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "gate_proof_bundle_sections_org_project" ON "gate_proof_bundle_sections" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "gate_proof_bundle_sections";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "gate_proof_bundle_sections" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
