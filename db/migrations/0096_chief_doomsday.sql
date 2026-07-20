CREATE TABLE "integration_fragments" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"capability" text NOT NULL,
	"provider_kind" text NOT NULL,
	"plane" text NOT NULL,
	"version" text NOT NULL,
	"body" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"created_by" text NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_fragments_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_fragments_status_check" CHECK ("integration_fragments"."status" = 'validated'),
	CONSTRAINT "integration_fragments_plane_check" CHECK ("integration_fragments"."plane" IN ('control','product')),
	CONSTRAINT "integration_fragments_digest_check" CHECK ("integration_fragments"."digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "integration_fragments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_fragments" ADD CONSTRAINT "integration_fragments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_fragments_org_cap_provider_version_unique" ON "integration_fragments" USING btree ("org_id","capability","provider_kind","version");--> statement-breakpoint
CREATE INDEX "integration_fragments_org_id" ON "integration_fragments" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_fragments" AS PERMISSIVE FOR ALL TO public USING ("integration_fragments"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_fragments"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "integration_fragments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- in-7 (EV-SUB-W1-A) owns the integration-family F2 authoring lifecycle. Insert
-- the frozen `integration.author.*` names before the producer can append, so the
-- events.event_type / notification_routes.event_name FK domain is satisfied.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('integration.author.started', 'ok'),
  ('integration.author.attempt', 'info'),
  ('integration.author.succeeded', 'ok'),
  ('integration.author.failed', 'fail')
ON CONFLICT ("name") DO NOTHING;
