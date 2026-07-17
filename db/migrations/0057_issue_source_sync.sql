-- Wave-4 bh-7 barrier. source_findings (0049) and webhook_events' claim
-- columns (0052) are deliberately reused rather than redefined here.
CREATE TABLE "source_sync_outbox" (
  "org_id" text NOT NULL,
  "id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "source_id" text NOT NULL,
  "operation" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "payload_hash" text NOT NULL,
  "claim_owner" text,
  "claim_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_sync_outbox_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "source_sync_outbox_state_check" CHECK ("source_sync_outbox"."state" IN ('pending','sent','verified','externally_closed_unverified')),
  CONSTRAINT "source_sync_outbox_payload_hash_check" CHECK ("source_sync_outbox"."payload_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "source_sync_outbox_claim_check" CHECK (("source_sync_outbox"."claim_owner" IS NULL AND "source_sync_outbox"."claim_expires_at" IS NULL) OR ("source_sync_outbox"."claim_owner" IS NOT NULL AND "source_sync_outbox"."claim_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_sync_outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "source_sync_outbox_org_id" ON "source_sync_outbox" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "source_sync_outbox_org_loop" ON "source_sync_outbox" USING btree ("org_id","issue_loop_id");
--> statement-breakpoint
CREATE INDEX "source_sync_outbox_org_source_state" ON "source_sync_outbox" USING btree ("org_id","source_id","state");
--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD CONSTRAINT "source_sync_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD CONSTRAINT "source_sync_outbox_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD CONSTRAINT "source_sync_outbox_source_fk" FOREIGN KEY ("org_id","source_id") REFERENCES "public"."inbox_sources"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "source_sync_outbox";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "source_sync_outbox" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
