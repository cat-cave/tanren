-- RLS wave R3b: the ENFORCEMENT flip.
--
-- The full DAL conversion (R1 → R2 cohorts 1-4 → R3a → R3a-worker) is complete:
-- every tenant-table op in every request AND worker path already carries org
-- context via `runWithOrgScope` / the per-job `orgScopingPool`. This migration
-- makes Postgres ENFORCE it: it adds `org_id` to `job_queue` (the worker's
-- tenant BOOTSTRAP source), creates the narrow `tanren_system` BYPASSRLS role
-- for genuinely cross-org system reads, and enables Row-Level Security + a
-- deny-by-default policy on EVERY tenant table.
--
-- Migrations still run as the OWNER (`tanren`, BYPASSRLS implicitly as owner),
-- so this DDL applies cleanly. Only the runtime query paths flip to the
-- restricted `tanren_app` role (NOBYPASSRLS, migration 0029) that the policies
-- below govern; `runWithSystemScope`'s own pool connects as `tanren_system`.
--
-- Idempotent: re-running the full migration set on an existing DB must not error.

-- 1. job_queue.org_id (drizzle-generated column add) + backfill. The queue stays
--    OUTSIDE RLS; this column lets the worker read the claimed job's org from the
--    queue row instead of an RLS-protected `runs` read — removing the hot-path
--    bootstrap tenant read entirely.
ALTER TABLE "job_queue" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint

-- Backfill existing queued/in-flight jobs from their owning run. A job with no
-- resolvable run (legacy/orphan) stays NULL — the worker treats a null job org
-- as a legacy/unscoped run (the pre-R3b fallback).
UPDATE "job_queue" jq
SET org_id = r.org_id
FROM "runs" r
WHERE jq.run_id = r.run_id
  AND jq.org_id IS NULL;--> statement-breakpoint

-- 2. The narrow BYPASSRLS system role. NOSUPERUSER (cannot escalate) but
--    BYPASSRLS so genuinely cross-org system reads — the reaper's lineage sweep
--    and cross-org dev seeding (phase1Fixture / createProject / the hello
--    fixture) — can resolve rows across tenants. `runWithSystemScope` gets its
--    OWN pool connecting as this role (TANREN_SYSTEM_DATABASE_URL); the default
--    runtime role `tanren_app` can NEVER bypass a policy.
--
--    DEV/CI default password (matches the 0029 `tanren_app` convention);
--    production rotates it out-of-band and supplies it via the system URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_system') THEN
    CREATE ROLE tanren_system LOGIN PASSWORD 'tanren_system'
      NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO tanren_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_system;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_system;--> statement-breakpoint

-- 3. Enable RLS + a deny-by-default policy on every tenant table.
--
--    `current_setting('app.current_org_id', true)` returns NULL when the GUC is
--    unset (the `true` = missing_ok). A policy comparing `org_id = <NULL>` is
--    never true, so an unscoped query (raw pool, empty GUC) sees ZERO rows and a
--    WITH CHECK write is rejected — deny-by-default. `runWithOrgScope` sets the
--    GUC via `SET LOCAL app.current_org_id`, so a correctly-scoped query behaves
--    EXACTLY as before (only cross-tenant access changes — now impossible).
--
--    Each policy is `FOR ALL` with both USING (read/update/delete row filter)
--    and WITH CHECK (insert/update row gate), so a row can neither be READ nor
--    WRITTEN for a different org. Idempotent via DROP POLICY IF EXISTS.
--
--    Tables WITHOUT their own org_id are scoped via their parent's org_id with
--    an EXISTS subquery — the subquery runs under the same GUC, so it resolves
--    the parent only when it belongs to the scoped org.

-- 3a. Direct-org_id tenant tables (org_id column = the tenant key).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'specs', 'runs', 'tasks', 'events', 'cost_records', 'runners',
    'personas', 'org_members', 'forge_threads', 'forge_action_proposals',
    'inbox_sources', 'candidates', 'notification_targets', 'audit_jobs',
    'org_quotas'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY rls_org_isolation ON %I FOR ALL
         USING (org_id = current_setting(''app.current_org_id'', true))
         WITH CHECK (org_id = current_setting(''app.current_org_id'', true))',
      t
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- 3b. organizations: the tenant root keys on `id` (not `org_id`).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON organizations;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON organizations FOR ALL
  USING (id = current_setting('app.current_org_id', true))
  WITH CHECK (id = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 3c. FK-scoped tenant tables (no own org_id; scoped via the parent's org_id).
--     The parent SELECT runs under the same GUC, so it resolves the parent row
--     only when it belongs to the scoped org → the EXISTS is true only then.
ALTER TABLE behaviors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behaviors;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behaviors FOR ALL
  USING (EXISTS (SELECT 1 FROM personas p WHERE p.id = behaviors.persona_id))
  WITH CHECK (EXISTS (SELECT 1 FROM personas p WHERE p.id = behaviors.persona_id));--> statement-breakpoint

ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON milestones;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON milestones FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = milestones.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = milestones.project_id));--> statement-breakpoint

ALTER TABLE spec_behaviors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_behaviors;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_behaviors FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_behaviors.spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_behaviors.spec_id));--> statement-breakpoint

ALTER TABLE spec_milestones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_milestones;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_milestones FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_milestones.spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_milestones.spec_id));--> statement-breakpoint

ALTER TABLE spec_dependencies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_dependencies;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_dependencies FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_dependencies.from_spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_dependencies.from_spec_id));--> statement-breakpoint

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON project_members;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON project_members FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_members.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_members.project_id));--> statement-breakpoint

ALTER TABLE forge_turns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON forge_turns;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON forge_turns FOR ALL
  USING (EXISTS (SELECT 1 FROM forge_threads ft WHERE ft.id = forge_turns.thread_id))
  WITH CHECK (EXISTS (SELECT 1 FROM forge_threads ft WHERE ft.id = forge_turns.thread_id));--> statement-breakpoint

ALTER TABLE workflow_insights ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON workflow_insights;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON workflow_insights FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = workflow_insights.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = workflow_insights.project_id));--> statement-breakpoint

ALTER TABLE notification_routes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON notification_routes;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON notification_routes FOR ALL
  USING (EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.id = notification_routes.target_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.id = notification_routes.target_id));
