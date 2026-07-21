CREATE TABLE "merge_runtime_outcomes" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"authority_decision_id" text,
	"effect_intent_id" text,
	"gate_proof_bundle_id" text NOT NULL,
	"proof_bundle_digest" text NOT NULL,
	"proof_root" text NOT NULL,
	"quarantine_version" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"tree_hash" text NOT NULL,
	"member_set_hash" text NOT NULL,
	"decision" text NOT NULL,
	"result" text NOT NULL,
	"main_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_runtime_outcomes_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_runtime_outcomes_decision_check" CHECK ("merge_runtime_outcomes"."decision" IN ('authorized','blocked','needs_attention')),
	CONSTRAINT "merge_runtime_outcomes_result_check" CHECK ("merge_runtime_outcomes"."result" IN ('landed','declined','quarantined')),
	CONSTRAINT "merge_runtime_outcomes_effect_shape_check" CHECK (("merge_runtime_outcomes"."result" = 'landed' AND "merge_runtime_outcomes"."decision" = 'authorized' AND "merge_runtime_outcomes"."authority_decision_id" IS NOT NULL AND "merge_runtime_outcomes"."effect_intent_id" IS NOT NULL AND "merge_runtime_outcomes"."main_sha" IS NOT NULL) OR ("merge_runtime_outcomes"."result" <> 'landed' AND "merge_runtime_outcomes"."authority_decision_id" IS NULL AND "merge_runtime_outcomes"."effect_intent_id" IS NULL AND "merge_runtime_outcomes"."main_sha" IS NULL)),
	CONSTRAINT "merge_runtime_outcomes_digest_check" CHECK ("merge_runtime_outcomes"."proof_bundle_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "merge_runtime_outcomes_proof_root_check" CHECK ("merge_runtime_outcomes"."proof_root" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ADD CONSTRAINT "merge_runtime_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ADD CONSTRAINT "merge_runtime_outcomes_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ADD CONSTRAINT "merge_runtime_outcomes_authority_decision_fk" FOREIGN KEY ("org_id","authority_decision_id") REFERENCES "public"."authority_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ADD CONSTRAINT "merge_runtime_outcomes_effect_intent_fk" FOREIGN KEY ("org_id","effect_intent_id") REFERENCES "public"."authority_effect_intents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" ADD CONSTRAINT "merge_runtime_outcomes_gate_proof_bundle_fk" FOREIGN KEY ("org_id","gate_proof_bundle_id") REFERENCES "public"."gate_proof_bundles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_runtime_outcomes_effect_intent_unique" ON "merge_runtime_outcomes" USING btree ("org_id","effect_intent_id");--> statement-breakpoint
CREATE INDEX "merge_runtime_outcomes_org_id" ON "merge_runtime_outcomes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "merge_runtime_outcomes_org_project" ON "merge_runtime_outcomes" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_runtime_outcomes" AS PERMISSIVE FOR ALL TO public USING ("merge_runtime_outcomes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_runtime_outcomes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "merge_runtime_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "event_types" ("name", "default_severity") VALUES ('merge.runtime_outcome.recorded', 'info') ON CONFLICT ("name") DO NOTHING;
