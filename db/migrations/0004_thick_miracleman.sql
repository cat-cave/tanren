ALTER TABLE "organizations" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
