-- Wave-3 barrier: webhook delivery identity, authentication provenance, and leases.
ALTER TABLE "webhook_events" ADD COLUMN "provider" text;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claim_owner" text;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claim_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "canonical_payload_hash" text;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "signature_algo" text;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "signature_key_version" text;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "delivery_signed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_claim_check" CHECK (("webhook_events"."claim_owner" IS NULL AND "webhook_events"."claim_expires_at" IS NULL) OR ("webhook_events"."claim_owner" IS NOT NULL AND "webhook_events"."claim_expires_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_canonical_payload_hash_check" CHECK ("webhook_events"."canonical_payload_hash" IS NULL OR "webhook_events"."canonical_payload_hash" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_delivery_unique" ON "webhook_events" USING btree ("org_id","source_id","provider","delivery_id") WHERE "delivery_id" IS NOT NULL;
