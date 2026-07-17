-- Wave-4 bh-5 barrier. The rv CAS/verification_artifacts substrate already
-- owns content-addressed evidence, storage location, retention, and redaction;
-- this migration adds only its missing assertion-level observation ledger.
CREATE TABLE "verification_assertions" (
  "org_id" text NOT NULL,
  "id" text NOT NULL,
  "verification_run_id" text NOT NULL,
  "expected_hash" text NOT NULL,
  "observed_hash" text NOT NULL,
  "outcome" text NOT NULL,
  "timing_ms" integer NOT NULL,
  "sample_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_assertions_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "verification_assertions_expected_hash_check" CHECK ("verification_assertions"."expected_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "verification_assertions_observed_hash_check" CHECK ("verification_assertions"."observed_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "verification_assertions_outcome_check" CHECK ("verification_assertions"."outcome" IN ('passed','failed','inconclusive')),
  CONSTRAINT "verification_assertions_timing_ms_check" CHECK ("verification_assertions"."timing_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "verification_assertions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "verification_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "verification_assertions_org_id" ON "verification_assertions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "verification_assertions_org_run" ON "verification_assertions" USING btree ("org_id","verification_run_id");
--> statement-breakpoint
ALTER TABLE "verification_assertions" ADD CONSTRAINT "verification_assertions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verification_assertions" ADD CONSTRAINT "verification_assertions_verification_run_fk" FOREIGN KEY ("org_id","verification_run_id") REFERENCES "public"."behavior_verification_runs"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "verification_assertions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "verification_assertions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
