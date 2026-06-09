CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"org_id" text NOT NULL,
	"event_type" text NOT NULL,
	"delivery_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('received','processed','failed','dead_lettered'))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_id_inbox_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbox_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_org_id" ON "webhook_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webhook_events_source_id" ON "webhook_events" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status" ON "webhook_events" USING btree ("status");--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on webhook_events (audit §3.6:
-- the durable raw-webhook landing table). The table carries its own `org_id` (the
-- tenant key), so it uses the 3a direct-org_id policy — identical to runs /
-- candidates / inbox_sources / merge_queue_holds. The policy compares
-- `org_id = current_setting('app.current_org_id', true)` (missing_ok): NEVER true
-- when the GUC is unset, so an unscoped query sees ZERO rows and a WITH CHECK write
-- is rejected (42501). `runWithOrgScope` sets the GUC via SET LOCAL, so a correctly-
-- scoped query behaves exactly as before. NO empty-on-missing-org fallback —
-- fail-closed by construction. Idempotent via DROP POLICY IF EXISTS.
-- ===========================================================================
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "webhook_events";--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "webhook_events" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
