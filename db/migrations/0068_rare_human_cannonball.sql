DROP INDEX "quarantined_tests_active_unique";--> statement-breakpoint
ALTER TABLE "quarantined_tests" ADD COLUMN "test_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "quarantined_tests_active_unique" ON "quarantined_tests" USING btree ("project_id",coalesce("test_id", "check_name")) WHERE "quarantined_tests"."cleared_at" IS NULL;

-- CI-intelligence PR2: per-test quarantine grain. `test_id` (nullable) lets a
-- single flaky TEST be quarantined without disabling the whole check job; NULL
-- keeps the original check-level grain. The active-unique index now keys on
-- coalesce(test_id, check_name), so a per-test row and a check-level row for the
-- same check never collide. RLS is unchanged — the existing project-scoped
-- `rls_org_isolation` policy on quarantined_tests (migration 0047) already
-- governs every column, including the new one (deny-by-default; a cross-org row
-- is unreadable AND unwritable).
