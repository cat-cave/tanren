ALTER TABLE "runs" ADD COLUMN "auth_ref" text;--> statement-breakpoint
CREATE INDEX "runs_org_auth_ref" ON "runs" USING btree ("org_id","auth_ref");
