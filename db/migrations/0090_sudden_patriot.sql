CREATE TABLE "governance_fragments" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"fragment_id" text NOT NULL,
	"version" text NOT NULL,
	"depends_on" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "governance_fragments_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "governance_fragments_status_check" CHECK ("governance_fragments"."status" = 'validated'),
	CONSTRAINT "governance_fragments_digest_check" CHECK ("governance_fragments"."digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "governance_fragments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "governance_fragments" ADD CONSTRAINT "governance_fragments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_fragments_org_fragment_version_unique" ON "governance_fragments" USING btree ("org_id","fragment_id","version");--> statement-breakpoint
CREATE INDEX "governance_fragments_org_id" ON "governance_fragments" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "governance_fragments" AS PERMISSIVE FOR ALL TO public USING ("governance_fragments"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("governance_fragments"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "governance_fragments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- gv-10 owns a distinct governance-family F2 lifecycle. Insert the frozen
-- names before the producer can append, preserving the event-type FK domain.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('governanceFragment.authoring.started', 'info'),
  ('governanceFragment.authoring.attempt', 'info'),
  ('governanceFragment.authoring.succeeded', 'info'),
  ('governanceFragment.authoring.failed', 'fail')
ON CONFLICT ("name") DO NOTHING;
