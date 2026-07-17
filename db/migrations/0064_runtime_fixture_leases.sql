-- Wave-6 rv-7 barrier: stateful, org-scoped fixture leases.
CREATE TABLE "fixture_leases" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "lease_id" text NOT NULL,
  "kind" text NOT NULL,
  "resource_ref" text NOT NULL,
  "correlation_namespace" text NOT NULL,
  "state" text NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "cleanup_evidence_hash" text,
  CONSTRAINT "fixture_leases_org_id_lease_id_pk" PRIMARY KEY("org_id","lease_id"),
  CONSTRAINT "fixture_leases_kind_check" CHECK ("fixture_leases"."kind" IN ('org','account','channel','dataset')),
  CONSTRAINT "fixture_leases_state_check" CHECK ("fixture_leases"."state" IN ('leased','released','expired')),
  CONSTRAINT "fixture_leases_cleanup_evidence_hash_check" CHECK ("fixture_leases"."cleanup_evidence_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fixture_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fixture_leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "fixture_leases_org_project_lease_id_unique" ON "fixture_leases" USING btree ("org_id","project_id","lease_id");
--> statement-breakpoint
CREATE INDEX "fixture_leases_org_id" ON "fixture_leases" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "fixture_leases" ADD CONSTRAINT "fixture_leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fixture_leases" ADD CONSTRAINT "fixture_leases_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "fixture_leases";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "fixture_leases" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
