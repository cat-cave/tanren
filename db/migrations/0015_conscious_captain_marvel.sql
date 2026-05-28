ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_outcome_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" IS NULL OR "runs"."outcome" IN ('hello_complete','phase1_fixture_complete','phase2_easy_complete','phase2_medium_complete','halted','escape_hatch_hit','retry_budget_exhausted','window_exhausted','cancelled','hello_world_complete','ok','failed','pending'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_outcome_check" CHECK ("tasks"."outcome" IS NULL OR "tasks"."outcome" IN ('passed','failed','rejected_by_checker','rejected_by_auditor','timed_out','crashed','window_exhausted','cancelled','ok','pending'));
