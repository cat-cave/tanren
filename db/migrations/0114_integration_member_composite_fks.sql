-- gv-17 CRA P1: bind integration_node_members.spec_id/run_id to same-org parents.
-- Rows that cannot satisfy the FKs (legacy/partial observe placeholders) are dropped
-- before the constraint is applied so migrate is fail-closed and deterministic.

DELETE FROM "integration_node_members" m
 WHERE NOT EXISTS (
   SELECT 1 FROM "specs" s WHERE s."org_id" = m."org_id" AND s."spec_id" = m."spec_id"
 );
--> statement-breakpoint
DELETE FROM "integration_node_members" m
 WHERE NOT EXISTS (
   SELECT 1 FROM "runs" r WHERE r."org_id" = m."org_id" AND r."run_id" = m."run_id"
 );
--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_spec_fk"
  FOREIGN KEY ("org_id", "spec_id") REFERENCES "public"."specs"("org_id", "spec_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_run_fk"
  FOREIGN KEY ("org_id", "run_id") REFERENCES "public"."runs"("org_id", "run_id")
  ON DELETE no action ON UPDATE no action;
