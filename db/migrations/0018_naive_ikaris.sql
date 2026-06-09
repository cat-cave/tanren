ALTER TABLE "organizations" ALTER COLUMN "config" SET DEFAULT '{"version":1}'::jsonb;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "config" SET DEFAULT '{"version":1}'::jsonb;--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "manifest" DROP DEFAULT;
