ALTER TABLE "specs" ADD COLUMN "priority" text DEFAULT 'tbd' NOT NULL;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_priority_check" CHECK ("specs"."priority" IN ('P0','P1','P2','tbd'));
