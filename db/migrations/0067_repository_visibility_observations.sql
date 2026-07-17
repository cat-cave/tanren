-- Wave-6 gv-11 barrier: immutable forge repository-visibility attestations.
CREATE TABLE "repository_visibility_observations" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "observed_visibility" text NOT NULL,
  "forge_ref" text NOT NULL,
  "sha" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repository_visibility_observations_org_id_observation_id_pk" PRIMARY KEY("org_id","observation_id"),
  CONSTRAINT "repository_visibility_observations_observed_visibility_check" CHECK ("repository_visibility_observations"."observed_visibility" IN ('public','private'))
);
--> statement-breakpoint
ALTER TABLE "repository_visibility_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repository_visibility_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_visibility_observations_org_project_observation_id_unique" ON "repository_visibility_observations" USING btree ("org_id","project_id","observation_id");
--> statement-breakpoint
CREATE INDEX "repository_visibility_observations_org_id" ON "repository_visibility_observations" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "repository_visibility_observations" ADD CONSTRAINT "repository_visibility_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_visibility_observations" ADD CONSTRAINT "repository_visibility_observations_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "repository_visibility_observations";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "repository_visibility_observations" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_repository_visibility_observations_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repository_visibility_observations rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "repository_visibility_observations_immutable"
BEFORE UPDATE OR DELETE ON "repository_visibility_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_repository_visibility_observations_immutable"();
