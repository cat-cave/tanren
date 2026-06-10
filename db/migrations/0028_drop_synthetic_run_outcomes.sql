ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" IS NULL OR "runs"."outcome" IN ('ok','halted','escape_hatch_hit','retry_budget_exhausted','convergence_stalled','window_exhausted','cancelled','failed'));
