DROP INDEX "job_queue_pending";--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "job_queue" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "job_queue" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "job_queue" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_queue_queued" ON "job_queue" USING btree ("task_kind","enqueued_at") WHERE "job_queue"."status" = 'queued';
