ALTER TABLE "source_sync_outbox" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "resolution_decision_id" text;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "provider_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "readback" jsonb;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD CONSTRAINT "source_sync_outbox_resolution_decision_fk" FOREIGN KEY ("org_id","resolution_decision_id") REFERENCES "public"."resolution_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sync_outbox" ADD CONSTRAINT "source_sync_outbox_close_authority_check" CHECK ("source_sync_outbox"."operation" <> 'close' OR "source_sync_outbox"."resolution_decision_id" IS NOT NULL);--> statement-breakpoint
CREATE FUNCTION "enforce_source_sync_close_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."operation" = 'close' AND NOT EXISTS (
    SELECT 1
      FROM "resolution_decisions" AS decision
     WHERE decision."org_id" = NEW."org_id"
       AND decision."id" = NEW."resolution_decision_id"
       AND decision."issue_loop_id" = NEW."issue_loop_id"
       AND decision."decision" IN ('authorized', 'waived')
  ) THEN
    RAISE EXCEPTION 'source close lacks an authorized ResolutionAuthority decision';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_sync_outbox_close_authority"
BEFORE INSERT OR UPDATE OF "org_id", "issue_loop_id", "operation", "resolution_decision_id" ON "source_sync_outbox"
FOR EACH ROW EXECUTE FUNCTION "enforce_source_sync_close_authority"();
