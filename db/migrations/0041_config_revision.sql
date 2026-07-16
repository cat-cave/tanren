ALTER TABLE "organizations" ADD COLUMN "config_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "config_revision" bigint DEFAULT 1 NOT NULL;
