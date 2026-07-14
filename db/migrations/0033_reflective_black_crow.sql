DROP INDEX "events_run_terminal_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "events_run_terminal_unique" ON "events" USING btree ("run_id","event_type") WHERE "events"."event_type" IN ('run.completed', 'run.failed', 'run.cancelled', 'run.resumed');
