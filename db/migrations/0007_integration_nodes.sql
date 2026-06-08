CREATE TABLE "integration_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"base_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"ref" text NOT NULL,
	"purpose" text NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_key" text NOT NULL,
	"gate_config_hash" text DEFAULT '' NOT NULL,
	"policy_version" text DEFAULT '' NOT NULL,
	"affected_fingerprint" text DEFAULT '' NOT NULL,
	"head_sha" text,
	"tree_hash" text,
	"status" text DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_nodes_purpose_check" CHECK ("integration_nodes"."purpose" IN ('eager_base','merge_batch','stack_head','bisect_prefix')),
	CONSTRAINT "integration_nodes_status_check" CHECK ("integration_nodes"."status" IN ('building','ready','landed','stale'))
);
--> statement-breakpoint
CREATE TABLE "integration_proofs" (
	"proof_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"proof_reuse_key" text NOT NULL,
	"verdict" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_node_id_integration_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."integration_nodes"("node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_nodes_org_id" ON "integration_nodes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_nodes_org_project" ON "integration_nodes" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_nodes_org_member_key_unique" ON "integration_nodes" USING btree ("org_id","member_key");--> statement-breakpoint
CREATE INDEX "integration_proofs_org_id" ON "integration_proofs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_proofs_org_project" ON "integration_proofs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "integration_proofs_node_id" ON "integration_proofs" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_proofs_org_reuse_key_unique" ON "integration_proofs" USING btree ("org_id","proof_reuse_key");--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on the new unified-run model
-- tables (tanren-owns-the-engine.md §3). Both carry their own `org_id` (the
-- tenant key), so they use the 3a direct-org_id policy — identical to runs /
-- merge_queue / post_merge_issue_claims. The policy compares
-- `org_id = current_setting('app.current_org_id', true)` (missing_ok): NEVER true
-- when the GUC is unset, so an unscoped query sees ZERO rows and a WITH CHECK
-- write is rejected (42501). `runWithOrgScope` sets the GUC via SET LOCAL, so a
-- correctly-scoped query behaves exactly as before. NO empty-on-missing-org
-- fallback — fail-closed by construction. Idempotent via DROP POLICY IF EXISTS.
-- The role GRANTs are covered by the baseline's ALTER DEFAULT PRIVILEGES FOR ROLE
-- tanren (these tables are created by that owner), so no explicit GRANT is needed.
-- ===========================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_nodes', 'integration_proofs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY rls_org_isolation ON %I FOR ALL
         USING (org_id = current_setting(''app.current_org_id'', true))
         WITH CHECK (org_id = current_setting(''app.current_org_id'', true))',
      t
    );
  END LOOP;
END
$$;
