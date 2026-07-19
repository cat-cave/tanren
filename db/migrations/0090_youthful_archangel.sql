ALTER TABLE "behavior_flake_quarantines" ADD COLUMN "epoch" text NOT NULL;--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ADD CONSTRAINT "behavior_flake_quarantines_epoch_check" CHECK ("behavior_flake_quarantines"."epoch" ~ '^sha256:[0-9a-f]{64}$');
