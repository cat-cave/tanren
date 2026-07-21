-- Migration 0038 created the V1 projection as raw SQL, outside Drizzle's historical
-- snapshot. Replace that predecessor before materializing the snapshot-tracked V2 shape.
DROP TABLE IF EXISTS "gate_proof_bundle_sections";--> statement-breakpoint
DROP TABLE IF EXISTS "gate_proof_bundles";--> statement-breakpoint
-- SP-3 binds these coordinates in every V2 seal. They remain nullable for historic
-- non-gate bundles; the V2 verifier requires every coordinate to be present.
ALTER TABLE "proof_bundles" ADD COLUMN "gate_config_hash" text;--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD COLUMN "runner_image" text;--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD COLUMN "app_env_hash" text;--> statement-breakpoint
ALTER TABLE "proof_bundles" ADD COLUMN "quarantine_version" text;--> statement-breakpoint
CREATE TABLE "gate_proof_bundle_sections" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"gate_proof_bundle_id" text NOT NULL,
	"proof_bundle_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"section_kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"required" boolean NOT NULL,
	CONSTRAINT "gate_proof_bundle_sections_org_id_gate_proof_bundle_id_proof_unit_digest_pk" PRIMARY KEY("org_id","gate_proof_bundle_id","proof_unit_digest"),
	CONSTRAINT "gate_proof_bundle_sections_section_kind_check" CHECK ("gate_proof_bundle_sections"."section_kind" IN ('native_ci', 'runtime_behavior', 'design_render', 'artifact_provenance')),
	CONSTRAINT "gate_proof_bundle_sections_proof_unit_digest_check" CHECK ("gate_proof_bundle_sections"."proof_unit_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_proof_bundles" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"gate_config_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"quarantine_version" text NOT NULL,
	"proof_bundle_id" text NOT NULL,
	"gate_verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_proof_bundles_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "gate_proof_bundles_gate_verdict_check" CHECK ("gate_proof_bundles"."gate_verdict" IN ('passed', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "gate_proof_bundle_sections_org_bundle_ordinal_unique" ON "gate_proof_bundle_sections" USING btree ("org_id","gate_proof_bundle_id","ordinal");--> statement-breakpoint
CREATE INDEX "gate_proof_bundle_sections_org_id" ON "gate_proof_bundle_sections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gate_proof_bundle_sections_org_project" ON "gate_proof_bundle_sections" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_proof_bundles_org_proof_bundle_id_unique" ON "gate_proof_bundles" USING btree ("org_id","proof_bundle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_proof_bundles_org_integration_node_id_unique" ON "gate_proof_bundles" USING btree ("org_id","integration_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_proof_bundles_org_id_proof_bundle_id_unique" ON "gate_proof_bundles" USING btree ("org_id","id","proof_bundle_id");--> statement-breakpoint
CREATE INDEX "gate_proof_bundles_org_id" ON "gate_proof_bundles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gate_proof_bundles_org_project" ON "gate_proof_bundles" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ADD CONSTRAINT "gate_proof_bundle_sections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ADD CONSTRAINT "gate_proof_bundle_sections_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ADD CONSTRAINT "gate_proof_bundle_sections_gate_bundle_fk" FOREIGN KEY ("org_id","gate_proof_bundle_id","proof_bundle_id") REFERENCES "public"."gate_proof_bundles"("org_id","id","proof_bundle_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ADD CONSTRAINT "gate_proof_bundle_sections_bundle_unit_fk" FOREIGN KEY ("org_id","proof_bundle_id","proof_unit_digest") REFERENCES "public"."proof_bundle_units"("org_id","bundle_id","proof_unit_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_integration_node_fk" FOREIGN KEY ("org_id","integration_node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_proof_bundle_fk" FOREIGN KEY ("org_id","proof_bundle_id") REFERENCES "public"."proof_bundles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "gate_proof_bundle_sections" AS PERMISSIVE FOR ALL TO public USING ("gate_proof_bundle_sections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("gate_proof_bundle_sections"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "gate_proof_bundles" AS PERMISSIVE FOR ALL TO public USING ("gate_proof_bundles"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("gate_proof_bundles"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" FORCE ROW LEVEL SECURITY;
