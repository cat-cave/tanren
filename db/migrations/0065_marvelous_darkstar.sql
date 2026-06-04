ALTER TABLE "merge_queue" DROP CONSTRAINT "merge_queue_dequeue_reason_check";--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_dequeue_reason_check" CHECK ("merge_queue"."dequeue_reason" IS NULL OR "merge_queue"."dequeue_reason" IN ('conflict','blocked','failed','superseded','needs_attention'));
