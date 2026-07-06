DROP INDEX "design_contracts_project_version_unique";--> statement-breakpoint
ALTER TABLE "design_contracts" ADD COLUMN "mode" text DEFAULT 'from_scratch' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "design_contracts_project_mode_version_unique" ON "design_contracts" USING btree ("project_id","mode","version");--> statement-breakpoint
ALTER TABLE "design_contracts" ADD CONSTRAINT "design_contracts_mode_check" CHECK ("design_contracts"."mode" IN ('specialize_seed', 'from_scratch'));
