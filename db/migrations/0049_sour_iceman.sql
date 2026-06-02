CREATE TABLE "post_merge_issue_claims" (
	"run_id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"issue_url" text,
	"issue_number" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filed_at" timestamp with time zone,
	CONSTRAINT "post_merge_issue_claims_status_check" CHECK ("post_merge_issue_claims"."status" IN ('claimed','filed'))
);
--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_merge_issue_claims_org_id" ON "post_merge_issue_claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "post_merge_issue_claims_org_project" ON "post_merge_issue_claims" USING btree ("org_id","project_id");--> statement-breakpoint

-- RLS for the post-merge issue-claim guard, mirroring merge_queue (migration 0045):
-- the table carries its OWN org_id, so it uses the 3a-style DIRECT org match (deny
-- by default; a row is readable/writable only under its own org's scope). The
-- atomic claim INSERT/UPDATE/DELETE all run under runWithOrgScope, so a cross-org
-- claim is both unreadable AND unwritable. Idempotent via DROP POLICY IF EXISTS.
ALTER TABLE post_merge_issue_claims ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON post_merge_issue_claims;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON post_merge_issue_claims FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
