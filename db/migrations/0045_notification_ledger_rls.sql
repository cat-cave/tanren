-- Mission-complete WAVE-1 barrier (gv-6): bring the legacy notification delivery
-- ledger under org-scoped Row-Level Security. The `notifications` dispatch ledger
-- was deliberately left OUTSIDE RLS by the collapsed baseline (it sat in the
-- "cross-org system tables" set alongside job_queue/users), while its sibling
-- notification_targets/notification_routes were RLS-forced. The governance spec
-- flags that gap explicitly ("the legacy delivery ledger remains outside RLS ...
-- That must be corrected") and requires direct `org_id` + forced RLS on every
-- delivery artifact.
--
-- Zero-user clean replacement: the ledger carries no production rows, so the
-- pre-org `tenant_id` tenant column is dropped in favour of a canonical, direct,
-- NOT NULL `org_id` (the tenant key every RLS policy compares), and RLS is
-- ENABLED + FORCED with the standard org-isolation policy — the exact
-- ENABLE → CREATE POLICY → FORCE shape migration 0043 established.
--
-- Route toggle: the notification ROUTE toggle the spec calls for
-- (`notification_routes.enabled`) already exists AND notification_routes is
-- already org-RLS-enforced (0000 baseline), so no toggle column is added here —
-- doing so would be cosplay. The remaining "fix route toggle" + Slack-contract
-- items in gv-6 are route-handler/provisioner CODE fixes, not schema barriers.
ALTER TABLE "notifications" ADD COLUMN "org_id" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "tenant_id";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notifications_org_id" ON "notifications" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING ("notifications"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("notifications"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
