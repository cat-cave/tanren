ALTER TABLE "ci_test_results" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD COLUMN "source_kind" text DEFAULT 'native_ci' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD COLUMN "behavior_verification_run_id" text;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD COLUMN "behavior_attempt_id" text;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_behavior_run_fk" FOREIGN KEY ("org_id","behavior_verification_run_id") REFERENCES "public"."behavior_verification_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_behavior_attempt_fk" FOREIGN KEY ("org_id","behavior_attempt_id") REFERENCES "public"."behavior_verification_attempts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_test_results_behavior_run" ON "ci_test_results" USING btree ("org_id","behavior_verification_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_test_results_behavior_attempt_unique" ON "ci_test_results" USING btree ("org_id","behavior_attempt_id") WHERE "ci_test_results"."source_kind" = 'behavior_verification';--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_source_kind_check" CHECK ("ci_test_results"."source_kind" IN ('native_ci','behavior_verification'));--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_source_shape_check" CHECK (("ci_test_results"."source_kind" = 'native_ci' AND "ci_test_results"."run_id" IS NOT NULL AND "ci_test_results"."behavior_verification_run_id" IS NULL AND "ci_test_results"."behavior_attempt_id" IS NULL) OR ("ci_test_results"."source_kind" = 'behavior_verification' AND "ci_test_results"."behavior_verification_run_id" IS NOT NULL AND "ci_test_results"."behavior_attempt_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ci_test_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ci_test_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "ci_test_results";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "ci_test_results" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
