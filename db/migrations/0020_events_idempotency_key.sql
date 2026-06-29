ALTER TABLE "events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "events_prior_idempotency_unique" ON "events" USING btree ("run_id","idempotency_key") WHERE "events"."idempotency_key" IS NOT NULL;
