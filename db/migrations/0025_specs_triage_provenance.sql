ALTER TABLE "specs" ADD COLUMN "parent_spec_id" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "source_finding_ids" text[];--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "origin_triage_task_id" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "origin_run_id" text;
