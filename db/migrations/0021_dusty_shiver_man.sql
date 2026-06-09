CREATE TABLE "merge_queue_holds" (
	"scope_id" text NOT NULL,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"attempts" text DEFAULT '0' NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_holds_kind_check" CHECK ("merge_queue_holds"."kind" IN ('recoverable_drive','batch_infra'))
);
--> statement-breakpoint
ALTER TABLE "merge_queue_holds" ADD CONSTRAINT "merge_queue_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_holds_identity" ON "merge_queue_holds" USING btree ("org_id","scope_id","kind");--> statement-breakpoint
CREATE INDEX "merge_queue_holds_org_id" ON "merge_queue_holds" USING btree ("org_id");--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on merge_queue_holds (audit
-- RC-7: persisted hold ceilings). The table carries its own `org_id` (the tenant
-- key), so it uses the 3a direct-org_id policy — identical to runs / merge_queue /
-- post_merge_issue_claims / integration_nodes. The policy compares
-- `org_id = current_setting('app.current_org_id', true)` (missing_ok): NEVER true
-- when the GUC is unset, so an unscoped query sees ZERO rows and a WITH CHECK write
-- is rejected (42501). `runWithOrgScope` sets the GUC via SET LOCAL, so a correctly-
-- scoped query behaves exactly as before. NO empty-on-missing-org fallback —
-- fail-closed by construction. Idempotent via DROP POLICY IF EXISTS.
-- ===========================================================================
ALTER TABLE "merge_queue_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "merge_queue_holds";--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "merge_queue_holds" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
