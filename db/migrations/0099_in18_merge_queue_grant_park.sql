ALTER TABLE "merge_queue" DROP CONSTRAINT "merge_queue_status_check";--> statement-breakpoint
DROP INDEX "merge_queue_active_run_unique";--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "park_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_active_run_unique" ON "merge_queue" USING btree ("run_id") WHERE status IN ('queued', 'merging', 'parked_grant');--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_park_reason_check" CHECK ("merge_queue"."park_reason" IS NULL OR "merge_queue"."status" = 'parked_grant');--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_status_check" CHECK ("merge_queue"."status" IN ('queued','merging','merged','dequeued','parked_grant'));
