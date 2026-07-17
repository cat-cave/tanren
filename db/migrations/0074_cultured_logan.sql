ALTER TABLE "resolution_jobs" DROP CONSTRAINT "resolution_jobs_state_check";--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_state_check" CHECK ("resolution_jobs"."state" IN ('queued','running','retryable','paused','authorized','blocked','needs_attention','waived','completed'));
