-- Custom SQL migration file, put your code below! --

-- RLS wave R1 (inert): the restricted runtime role.
--
-- Postgres RLS is BYPASSED by the table owner and by any superuser. The dev/CI
-- `tanren` role is the owner AND a superuser, so RLS could never bite while the
-- runtime connects as `tanren`. R1 therefore introduces a NON-owner,
-- NON-superuser login role (`tanren_app`) that the runtime connects as. R2 will
-- ENABLE RLS + add policies; once that lands, this role is the one the policies
-- govern. Until then this migration is BEHAVIOR-NEUTRAL: with no policies, the
-- role has the same SELECT/INSERT/UPDATE/DELETE reach the owner had.
--
-- Migrations keep running as the OWNER (`tanren`): drizzle connects with the
-- migration DATABASE_URL (owner) so CREATE/ALTER TABLE stays owner-driven. Only
-- the request/worker query paths connect as `tanren_app` (a separate runtime
-- DATABASE_URL — see compose + docs/roadmap/saas-rls-and-plane-split-plan.md).
--
-- Idempotent: re-running the full migration set on an existing DB must not error.

-- 1. The runtime role. Created NOSUPERUSER / NOCREATEDB / NOCREATEROLE /
--    NOBYPASSRLS so it can never bypass a future policy. LOGIN with a DEV/CI
--    default password; production rotates it out-of-band
--    (`ALTER ROLE tanren_app PASSWORD '<secret>'`) and supplies the secret via
--    the runtime DATABASE_URL — the literal here is NOT a prod credential, only
--    a deterministic local/CI default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_app') THEN
    CREATE ROLE tanren_app LOGIN PASSWORD 'tanren_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- 2. Schema reach: the role must resolve objects in `public` but never create
--    them (DDL stays owner-only). USAGE only, no CREATE.
GRANT USAGE ON SCHEMA public TO tanren_app;

-- 3. Table privileges: every CURRENT table (tenant + cross-org system tables
--    alike). RLS — added in R2 — restricts the ROWS a SELECT/UPDATE/DELETE sees;
--    these GRANTs are the base privilege RLS then filters. Genuinely cross-org
--    system tables (job_queue, notifications, sessions, …) stay OUTSIDE RLS in
--    R2, so the role keeps full reach there; the worker uses a system context
--    for the claim, then sets the claimed job's org for tenant work.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_app;

-- 4. Sequence privileges: the bigserial PK tables (events, cost_records,
--    job_queue, notifications, rate_limit_observations) need nextval/currval.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_app;

-- 5. Future objects: any table/sequence a LATER migration creates (still as the
--    owner `tanren`) is auto-granted to the runtime role, so a new R-wave table
--    needs no extra GRANT bookkeeping. Scoped to objects the owner creates.
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_app;
