-- RV-4 serialized tail: replace the unsafe scalar
-- behavior_coverage_edges(project_id) foreign key created by 0037 with a
-- composite (org_id, project_id) foreign key onto IN-1's canonical project key
-- (the projects_org_project_unique key established by 0043). This binds every
-- coverage edge to the exact org-scoped project lineage rather than a bare,
-- cross-org-collidable project_id. No compatibility column, backfill, event
-- seed, or second authority: W0 already seeded
-- behavior.coverage.selection_analyzed in 0042.
ALTER TABLE "behavior_coverage_edges" DROP CONSTRAINT IF EXISTS "behavior_coverage_edges_project_fk";
--> statement-breakpoint
ALTER TABLE "behavior_coverage_edges" ADD CONSTRAINT "behavior_coverage_edges_project_lineage_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
