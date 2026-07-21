ALTER TABLE "gate_proof_bundle_sections" DROP CONSTRAINT "gate_proof_bundle_sections_project_id_projects_project_id_fk";--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" DROP CONSTRAINT "gate_proof_bundles_project_id_projects_project_id_fk";--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD COLUMN "integration_node_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD COLUMN "gate_config_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD COLUMN "policy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" ADD CONSTRAINT "gate_proof_bundles_integration_node_fk" FOREIGN KEY ("org_id","integration_node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" ADD CONSTRAINT "gate_proof_bundle_sections_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gate_proof_bundles_org_integration_node_id_unique" ON "gate_proof_bundles" USING btree ("org_id","integration_node_id");--> statement-breakpoint
ALTER TABLE "gate_proof_bundles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gate_proof_bundle_sections" FORCE ROW LEVEL SECURITY;
