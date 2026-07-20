CREATE TABLE "merge_train_artifacts" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"land_group_id" text NOT NULL,
	"authority_decision_id" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"proof_root" text NOT NULL,
	"receipt_audit_id" text NOT NULL,
	"receipt_main_sha" text NOT NULL,
	"deploy_provider" text NOT NULL,
	"deploy_app_id" text NOT NULL,
	"deploy_deployment_id" text NOT NULL,
	"demo_surface_kind" text NOT NULL,
	"demo_behavior_count" integer NOT NULL,
	"demo_passed" integer NOT NULL,
	"bundle_id" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"bytes_digest" text NOT NULL,
	"content_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_train_artifacts_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "merge_train_artifacts_proof_root_check" CHECK ("merge_train_artifacts"."proof_root" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "merge_train_artifacts_bundle_digest_check" CHECK ("merge_train_artifacts"."bundle_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "merge_train_artifacts_bytes_digest_check" CHECK ("merge_train_artifacts"."bytes_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "merge_train_artifacts_content_hash_check" CHECK ("merge_train_artifacts"."content_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_land_group_fk" FOREIGN KEY ("org_id","land_group_id") REFERENCES "public"."land_groups"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_decision_fk" FOREIGN KEY ("org_id","authority_decision_id") REFERENCES "public"."authority_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_bundle_fk" FOREIGN KEY ("org_id","bundle_id") REFERENCES "public"."proof_bundles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" ADD CONSTRAINT "merge_train_artifacts_bytes_cas_fk" FOREIGN KEY ("org_id","bytes_digest") REFERENCES "public"."cas_artifacts"("org_id","digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_train_artifacts_org_land_group_unique" ON "merge_train_artifacts" USING btree ("org_id","land_group_id");--> statement-breakpoint
CREATE INDEX "merge_train_artifacts_org_id" ON "merge_train_artifacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "merge_train_artifacts_org_project" ON "merge_train_artifacts" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_train_artifacts" AS PERMISSIVE FOR ALL TO public USING ("merge_train_artifacts"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_train_artifacts"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "merge_train_artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- mq-15: the merge-train artifact is an append-only sealed projection. Reject any
-- UPDATE/DELETE so a sealed delivery can never be silently rewritten or removed.
CREATE FUNCTION "enforce_merge_train_artifacts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (append-only): % rejected', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "merge_train_artifacts_immutable"
BEFORE UPDATE OR DELETE ON "merge_train_artifacts"
FOR EACH ROW EXECUTE FUNCTION "enforce_merge_train_artifacts_immutable"();
--> statement-breakpoint
-- mq-15 owns the frozen `merge.train.artifact.sealed` name. Insert it before the
-- watcher can append, so the events.event_type / notification_routes.event_name FK
-- domain is satisfied.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.train.artifact.sealed', 'ok')
ON CONFLICT ("name") DO NOTHING;
