ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_check";--> statement-breakpoint
ALTER TABLE "specs" DROP CONSTRAINT "specs_status_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_agent_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_outcome_check";--> statement-breakpoint
ALTER TABLE "specs" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('queued','running','halted','completed','failed','cancelled'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" IS NULL OR "runs"."outcome" IN ('ok','hello_complete','phase1_fixture_complete','phase2_easy_complete','phase2_medium_complete','halted','escape_hatch_hit','retry_budget_exhausted','window_exhausted','cancelled','failed'));--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_status_check" CHECK ("specs"."status" IN ('open','in_flight','review','merged','halted','cancelled','needs_attention'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_kind_check" CHECK ("tasks"."agent_kind" IN ('system','operator','writer','answerer','forge_template','ci_poller'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_outcome_check" CHECK ("tasks"."outcome" IS NULL OR "tasks"."outcome" IN ('passed','ok','pending','failed','rejected_by_checker','rejected_by_auditor','timed_out','crashed','window_exhausted','cancelled'));
