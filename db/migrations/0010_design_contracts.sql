CREATE TABLE "design_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"domain" text NOT NULL,
	"contract" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_contracts_version_check" CHECK ("design_contracts"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "design_contracts" ADD CONSTRAINT "design_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_contracts" ADD CONSTRAINT "design_contracts_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_contracts_project_version_unique" ON "design_contracts" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "design_contracts_org_id" ON "design_contracts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "design_contracts_project_id" ON "design_contracts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "design_contracts_domain" ON "design_contracts" USING btree ("domain");--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on `design_contracts`.
--
-- A design contract is PRIVATE to its owning org — there is no cross-org
-- catalogue tier (unlike templates/environments). Direct org_id isolation
-- (migration 0000 §3a pattern): the USING clause admits a row only when org_id
-- matches the request's `app.current_org_id` GUC (unset ⇒ ZERO rows, exactly
-- like every other tenant table), and the WITH CHECK keeps writes org-owned.
-- Idempotent via DROP POLICY IF EXISTS. See db/src/schemaDesign.ts.
-- ===========================================================================
ALTER TABLE design_contracts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON design_contracts;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON design_contracts FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
