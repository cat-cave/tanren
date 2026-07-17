-- Wave-4 gv-8 barrier: immutable tier definitions and their active effective
-- policy bindings. The binding is mutable operational selection; a tier itself
-- is append-only, mirroring governance_policy_revisions from 0047.
CREATE TABLE "governance_tiers" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "tier_name" text NOT NULL,
  "preset" text NOT NULL,
  "tier_json" jsonb NOT NULL,
  "canonical_hash" text NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "governance_tiers_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "governance_tiers_canonical_hash_check" CHECK ("governance_tiers"."canonical_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "policy_bindings" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "tier_id" text NOT NULL,
  "effective_policy_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "policy_bindings_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "policy_bindings_effective_policy_hash_check" CHECK ("policy_bindings"."effective_policy_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_visibility" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_repo_visibility_check" CHECK ("projects"."repo_visibility" IN ('public','private'));
--> statement-breakpoint
ALTER TABLE "governance_tiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "governance_tiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "policy_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "policy_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "governance_tiers_org_project_id_unique" ON "governance_tiers" USING btree ("org_id","project_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "governance_tiers_project_name_unique" ON "governance_tiers" USING btree ("org_id","project_id","tier_name");
--> statement-breakpoint
CREATE INDEX "governance_tiers_org_id" ON "governance_tiers" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "governance_tiers_org_project_hash" ON "governance_tiers" USING btree ("org_id","project_id","canonical_hash");
--> statement-breakpoint
CREATE INDEX "policy_bindings_org_id" ON "policy_bindings" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "policy_bindings_org_project" ON "policy_bindings" USING btree ("org_id","project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_bindings_org_project_tier_unique" ON "policy_bindings" USING btree ("org_id","project_id","tier_id");
--> statement-breakpoint
ALTER TABLE "governance_tiers" ADD CONSTRAINT "governance_tiers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "governance_tiers" ADD CONSTRAINT "governance_tiers_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_bindings" ADD CONSTRAINT "policy_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_bindings" ADD CONSTRAINT "policy_bindings_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_bindings" ADD CONSTRAINT "policy_bindings_tier_fk" FOREIGN KEY ("org_id","project_id","tier_id") REFERENCES "public"."governance_tiers"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "governance_tiers";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "governance_tiers" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "policy_bindings";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "policy_bindings" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "reject_governance_tier_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_tiers is append-only; % is not permitted', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "governance_tiers_append_only"
BEFORE UPDATE OR DELETE ON "governance_tiers"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_tier_mutation"();
