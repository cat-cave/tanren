ALTER TABLE "notification_targets" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_base_url_check" CHECK ("notification_targets"."base_url" IS NULL OR "notification_targets"."base_url" ~ '^https?://');
