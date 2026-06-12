CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env_key" text NOT NULL,
	"image_ref" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"channel" text DEFAULT 'lts' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provenance" jsonb NOT NULL,
	"validation_proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_status_check" CHECK ("environments"."status" IN ('draft','validated','official')),
	CONSTRAINT "environments_channel_check" CHECK ("environments"."channel" IN ('lts','nightly'))
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_org_env_key" ON "environments" USING btree ("org_id","env_key");--> statement-breakpoint
CREATE INDEX "environments_org_id" ON "environments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "environments_status" ON "environments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "environments_channel" ON "environments" USING btree ("channel");--> statement-breakpoint

-- RLS: environments mirror the `templates` policy (migration 0000 §3c) — direct
-- org_id WITH a cross-org-READABLE `official` tier so any org can RESOLVE from a
-- blessed environment, while the WITH CHECK keeps the write side org-owned (no
-- official escape hatch — an official env is authored only under the platform org
-- that owns the row). Deny-by-default: an unscoped client (empty GUC) sees only
-- official rows. See db/src/schemaEnvironments.ts for the scoping rationale.
ALTER TABLE environments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON environments;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON environments FOR ALL
  USING (org_id = current_setting('app.current_org_id', true) OR status = 'official')
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
