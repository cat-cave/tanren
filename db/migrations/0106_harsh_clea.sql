CREATE TABLE "integration_evidence_failures" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"delivery_run_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_generation" integer NOT NULL,
	"classification" text NOT NULL,
	"redacted_detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_evidence_failures_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_evidence_failures_generation_check" CHECK ("integration_evidence_failures"."binding_generation" >= 1),
	CONSTRAINT "integration_evidence_failures_classification_check" CHECK ("integration_evidence_failures"."classification" IN ('grant_revoked','correlation_join_mismatch','evidence_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "integration_evidence_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_runtime_attachments" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"delivery_run_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_generation" integer NOT NULL,
	"deploy_sha" text NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_runtime_attachments_org_id_delivery_run_id_binding_id_binding_generation_pk" PRIMARY KEY("org_id","delivery_run_id","binding_id","binding_generation"),
	CONSTRAINT "integration_runtime_attachments_generation_check" CHECK ("integration_runtime_attachments"."binding_generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "integration_runtime_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "channel_template_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "negative_control_checklist" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "bundle_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "bundle_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "bundle_bytes_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "signing_key_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD COLUMN "dsse_bundle" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_evidence_failures" ADD CONSTRAINT "integration_evidence_failures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_evidence_failures" ADD CONSTRAINT "integration_evidence_failures_delivery_binding_fk" FOREIGN KEY ("org_id","project_id","delivery_run_id","binding_id","binding_generation") REFERENCES "public"."delivery_run_bindings"("org_id","project_id","delivery_run_id","binding_id","binding_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runtime_attachments" ADD CONSTRAINT "integration_runtime_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runtime_attachments" ADD CONSTRAINT "integration_runtime_attachments_delivery_binding_fk" FOREIGN KEY ("org_id","project_id","delivery_run_id","binding_id","binding_generation") REFERENCES "public"."delivery_run_bindings"("org_id","project_id","delivery_run_id","binding_id","binding_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_evidence_failures_coordinate_unique" ON "integration_evidence_failures" USING btree ("org_id","delivery_run_id","binding_id","binding_generation","classification");--> statement-breakpoint
CREATE INDEX "integration_evidence_failures_org_id" ON "integration_evidence_failures" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_runtime_attachments_org_id" ON "integration_runtime_attachments" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_channel_template_digest_check" CHECK ("integration_validation_proofs"."channel_template_digest" ~ '^sha256:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_bundle_digest_check" CHECK ("integration_validation_proofs"."bundle_digest" ~ '^sha256:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_bundle_bytes_digest_check" CHECK ("integration_validation_proofs"."bundle_bytes_digest" ~ '^sha256:[0-9a-f]{64}$');--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_evidence_failures" AS PERMISSIVE FOR ALL TO public USING ("integration_evidence_failures"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_evidence_failures"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_runtime_attachments" AS PERMISSIVE FOR ALL TO public USING ("integration_runtime_attachments"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_runtime_attachments"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "integration_evidence_failures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_runtime_attachments" FORCE ROW LEVEL SECURITY;
