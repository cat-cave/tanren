ALTER TABLE "resolution_decisions" ADD COLUMN "decision_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD COLUMN "authority_version" text NOT NULL DEFAULT 'tanren-resolution-authority.v1';--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD COLUMN "contract_id" text;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD COLUMN "release_instance_id" text;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD COLUMN "verification_run_id" text;--> statement-breakpoint
UPDATE "resolution_decisions" AS decision
   SET "contract_id" = job."contract_id"
  FROM "resolution_jobs" AS job
 WHERE job."org_id" = decision."org_id"
   AND job."id" = decision."resolution_job_id"
   AND decision."contract_id" IS NULL;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ALTER COLUMN "contract_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ALTER COLUMN "decision_reasons" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "resolution_decisions" ALTER COLUMN "authority_version" DROP DEFAULT;
