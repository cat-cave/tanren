CREATE TABLE "cas_artifacts" (
	"org_id" text NOT NULL,
	"digest" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"media_type" text NOT NULL,
	"storage_backend" text NOT NULL,
	"storage_key" text,
	"inline_bytes" bytea,
	"provider_checksum" text,
	"encryption_state" text DEFAULT 'none' NOT NULL,
	"retention_class" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cas_artifacts_digest_check" CHECK ("cas_artifacts"."digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "cas_artifacts_storage_backend_check" CHECK ("cas_artifacts"."storage_backend" IN ('inline_pg', 'object_store')),
	CONSTRAINT "cas_artifacts_provider_checksum_check" CHECK ("cas_artifacts"."provider_checksum" IS NULL OR "cas_artifacts"."provider_checksum" ~ '^sha512:[0-9a-f]{128}$'),
	CONSTRAINT "cas_artifacts_encryption_state_check" CHECK ("cas_artifacts"."encryption_state" IN ('none', 'aes256_gcm')),
	CONSTRAINT "cas_artifacts_storage_location_check" CHECK (("cas_artifacts"."storage_backend" = 'inline_pg' AND "cas_artifacts"."inline_bytes" IS NOT NULL AND "cas_artifacts"."storage_key" IS NULL) OR ("cas_artifacts"."storage_backend" = 'object_store' AND "cas_artifacts"."storage_key" IS NOT NULL AND "cas_artifacts"."inline_bytes" IS NULL)),
	CONSTRAINT "cas_artifacts_org_id_digest_pk" PRIMARY KEY ("org_id", "digest")
);
--> statement-breakpoint
ALTER TABLE "cas_artifacts" ADD CONSTRAINT "cas_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cas_artifacts_org_id" ON "cas_artifacts" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "cas_artifacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cas_artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "cas_artifacts";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "cas_artifacts" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "proof_units" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"kind" text NOT NULL,
	"verdict" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_units_digest_check" CHECK ("proof_units"."proof_unit_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_units_kind_check" CHECK ("proof_units"."kind" IN ('native_ci_tier', 'native_ci_step', 'test', 'runtime_behavior', 'design_render', 'artifact_provenance', 'audit_rule', 'security_finding')),
	CONSTRAINT "proof_units_verdict_check" CHECK ("proof_units"."verdict" IN ('passed', 'failed', 'unknown')),
	CONSTRAINT "proof_units_org_id_digest_pk" PRIMARY KEY ("org_id", "proof_unit_digest"),
	CONSTRAINT "proof_units_cas_artifact_fk" FOREIGN KEY ("org_id", "proof_unit_digest") REFERENCES "cas_artifacts"("org_id", "digest") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "proof_units" ADD CONSTRAINT "proof_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_units" ADD CONSTRAINT "proof_units_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "proof_units_org_id" ON "proof_units" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "proof_units_org_project" ON "proof_units" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "proof_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proof_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "proof_units";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "proof_units" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "proof_unit_evidence" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "proof_unit_evidence_digest_check" CHECK ("proof_unit_evidence"."evidence_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_unit_evidence_org_unit_evidence_pk" PRIMARY KEY ("org_id", "proof_unit_digest", "evidence_digest"),
	CONSTRAINT "proof_unit_evidence_unit_fk" FOREIGN KEY ("org_id", "proof_unit_digest") REFERENCES "proof_units"("org_id", "proof_unit_digest") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "proof_unit_evidence_cas_artifact_fk" FOREIGN KEY ("org_id", "evidence_digest") REFERENCES "cas_artifacts"("org_id", "digest") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "proof_unit_evidence_org_id" ON "proof_unit_evidence" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "proof_unit_evidence_org_project" ON "proof_unit_evidence" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "proof_unit_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proof_unit_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "proof_unit_evidence";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "proof_unit_evidence" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "proof_unit_edges" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_unit_digest" text NOT NULL,
	"child_unit_digest" text NOT NULL,
	"relation" text DEFAULT 'depends_on' NOT NULL,
	CONSTRAINT "proof_unit_edges_parent_digest_check" CHECK ("proof_unit_edges"."parent_unit_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_unit_edges_child_digest_check" CHECK ("proof_unit_edges"."child_unit_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_unit_edges_not_self_check" CHECK ("proof_unit_edges"."parent_unit_digest" <> "proof_unit_edges"."child_unit_digest"),
	CONSTRAINT "proof_unit_edges_org_parent_child_pk" PRIMARY KEY ("org_id", "parent_unit_digest", "child_unit_digest"),
	CONSTRAINT "proof_unit_edges_parent_fk" FOREIGN KEY ("org_id", "parent_unit_digest") REFERENCES "proof_units"("org_id", "proof_unit_digest") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "proof_unit_edges_child_fk" FOREIGN KEY ("org_id", "child_unit_digest") REFERENCES "proof_units"("org_id", "proof_unit_digest") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "proof_unit_edges_org_id" ON "proof_unit_edges" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "proof_unit_edges_org_project" ON "proof_unit_edges" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "proof_unit_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proof_unit_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "proof_unit_edges";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "proof_unit_edges" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "proof_bundles" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"proof_root" text NOT NULL,
	"bytes_digest" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"member_set_hash" text NOT NULL,
	"prepared_head_sha" text NOT NULL,
	"jj_tree_id" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"expected_main_sha" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"root_signature" bytea NOT NULL,
	"nonce" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_bundles_bundle_digest_check" CHECK ("proof_bundles"."bundle_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_bundles_proof_root_check" CHECK ("proof_bundles"."proof_root" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_bundles_bytes_digest_check" CHECK ("proof_bundles"."bytes_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_bundles_artifact_digest_check" CHECK ("proof_bundles"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "proof_bundles_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "proof_bundles_org_bundle_digest_unique" UNIQUE ("org_id", "bundle_digest"),
	CONSTRAINT "proof_bundles_bytes_cas_artifact_fk" FOREIGN KEY ("org_id", "bytes_digest") REFERENCES "cas_artifacts"("org_id", "digest") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "proof_bundles_artifact_cas_artifact_fk" FOREIGN KEY ("org_id", "artifact_digest") REFERENCES "cas_artifacts"("org_id", "digest") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD CONSTRAINT "proof_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD CONSTRAINT "proof_bundles_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "proof_bundles_org_id" ON "proof_bundles" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "proof_bundles_org_project" ON "proof_bundles" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "proof_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proof_bundles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "proof_bundles";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "proof_bundles" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "proof_bundle_units" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "proof_bundle_units_org_bundle_unit_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "proof_bundle_units_org_bundle_ordinal_unique" UNIQUE ("org_id", "bundle_id", "ordinal"),
	CONSTRAINT "proof_bundle_units_org_bundle_unit_unique" UNIQUE ("org_id", "bundle_id", "proof_unit_digest"),
	CONSTRAINT "proof_bundle_units_bundle_fk" FOREIGN KEY ("org_id", "bundle_id") REFERENCES "proof_bundles"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "proof_bundle_units_unit_fk" FOREIGN KEY ("org_id", "proof_unit_digest") REFERENCES "proof_units"("org_id", "proof_unit_digest") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "proof_bundle_units_org_id" ON "proof_bundle_units" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "proof_bundle_units_org_project" ON "proof_bundle_units" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "proof_bundle_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proof_bundle_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "proof_bundle_units";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "proof_bundle_units" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
