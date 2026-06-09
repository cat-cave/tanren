CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_ref" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel" text DEFAULT 'lts' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_status_check" CHECK ("templates"."status" IN ('draft','validated','degraded','official')),
	CONSTRAINT "templates_channel_check" CHECK ("templates"."channel" IN ('lts','nightly'))
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_org_id" ON "templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "templates_status" ON "templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "templates_channel" ON "templates" USING btree ("channel");--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on `templates`, WITH an
-- official/cat-cave cross-org-READABLE tier.
--
-- A private template (status draft/validated/degraded) is visible ONLY to its
-- owning org: the USING clause admits a row when org_id matches the request's
-- `app.current_org_id` GUC (unset ⇒ zero rows, exactly like every other tenant
-- table). An OFFICIAL template (the reviewed cat-cave tier) is additionally
-- admitted to EVERY org's SELECT (`OR status = 'official'`) so any org can SEED
-- from the shared catalogue.
--
-- WRITES stay org-scoped: the WITH CHECK clause keeps org_id = current_org_id
-- with NO official escape hatch, so a row can only be INSERTed/UPDATEd under the
-- org that owns it — an official template is authored/blessed only by a platform
-- admin acting in the platform org (the row's org_id). This matches the 3a
-- direct-org_id policy shape (the baseline RLS block) with the single additive
-- read-side exception for the shared tier. Idempotent via DROP POLICY IF EXISTS.
-- ===========================================================================
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON templates;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON templates FOR ALL
  USING (org_id = current_setting('app.current_org_id', true) OR status = 'official')
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
