ALTER TABLE "organizations" ADD COLUMN "config_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "config_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_config_revision_range_check" CHECK ("organizations"."config_revision" >= 1 AND "organizations"."config_revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_config_revision_range_check" CHECK ("projects"."config_revision" >= 1 AND "projects"."config_revision" <= 9007199254740991);
