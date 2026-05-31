-- Custom SQL migration file, put your code below! --

-- Plane-split P3b: the de-privileged DATA-PLANE runtime role.
--
-- P3a routed the worker's run-state WRITES — event-append, cost-record insert,
-- and run finalize — through the control-plane `/internal/*` endpoints over mTLS
-- (behind TANREN_DATA_PLANE_REMOTE_WRITES, default-direct). P3b flips that flag
-- ON for the standalone `worker` container and DROPS the data plane's privilege
-- to write the two tenant tables it no longer touches directly: `events` and
-- `cost_records`. A compromised runner connecting as this role can no longer
-- forge a timeline event or a cost record in the control DB — Postgres itself
-- rejects the INSERT/UPDATE/DELETE.
--
-- Why ONLY `events` + `cost_records` this wave (the honest audit — see
-- docs/roadmap/saas-rls-and-plane-split-plan.md / R-WAVES.md P3b):
--   * With remote-writes ON, the worker (and its co-located reaper) route EVERY
--     `events` and `cost_records` write through the control plane — the workflow
--     gets the remote `RunStateWriter` as its eventStore/recorder, the worker's
--     failure-path finalizers route through it, and the reaper's dead-letter
--     event is injected with it. So the data plane writes NEITHER table directly.
--     It does NOT read `events` at all; it reads `cost_records` once (post-run
--     usage accrual) — so `events` loses ALL grants, `cost_records` keeps SELECT.
--   * The workflow STILL writes `runs` (the `running` transition), `specs`
--     (`in_flight`), and `tasks` (the subtask-loop lifecycle) directly via its
--     org-scoped pool — those are NOT yet behind a control-plane endpoint
--     (routing the full run/spec/task lifecycle is a larger sub-feature, flagged
--     for a later wave). The role keeps its write grants there. `job_queue` and
--     the other cross-org system tables stay OUTSIDE RLS; the role keeps them.
--
-- Migrations keep running as the OWNER (`tanren`); only the `worker` container's
-- runtime pool connects as `tanren_dataplane` (a separate runtime DATABASE_URL —
-- see compose). The control-plane API keeps `tanren_app`.
--
-- Idempotent: re-running the full migration set on an existing DB must not error.

-- 1. The data-plane runtime role. Created like `tanren_app` (0029): a NON-owner,
--    NON-superuser, NOBYPASSRLS login role the RLS policies (0030) govern. A
--    DEV/CI default password; production rotates it out-of-band
--    (`ALTER ROLE tanren_dataplane PASSWORD '<secret>'`) and supplies it via the
--    worker's runtime DATABASE_URL — the literal here is NOT a prod credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_dataplane') THEN
    CREATE ROLE tanren_dataplane LOGIN PASSWORD 'tanren_dataplane'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint

-- 2. Schema reach: resolve objects in `public`, never create them (DDL stays
--    owner-only). USAGE only, no CREATE.
GRANT USAGE ON SCHEMA public TO tanren_dataplane;--> statement-breakpoint

-- 3. Base table reach: start from the SAME grants `tanren_app` has on every
--    current table, so the data plane keeps the reads + the run/spec/task writes
--    its workflow still drives directly. The de-privilege is the targeted REVOKE
--    in step 5; this is the base RLS then row-filters.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_dataplane;--> statement-breakpoint

-- 4. Sequence reach: the bigserial PK tables the data plane still writes need
--    nextval/currval (job_queue, etc.). The `events`/`cost_records` sequences are
--    only advanced by an INSERT, which the role can no longer do — keeping the
--    (read-only) USAGE here is harmless and avoids per-sequence bookkeeping.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_dataplane;--> statement-breakpoint

-- 5. THE DE-PRIVILEGE. Drop EVERY write on `events` (the data plane neither reads
--    nor writes it now → revoke ALL) and the WRITES on `cost_records` (it only
--    reads it for usage accrual → keep SELECT, drop INSERT/UPDATE/DELETE). With
--    remote-writes ON these writes go through the control plane, so dropping the
--    grant is the security payoff: a direct write by this role is now rejected by
--    Postgres (a `permission denied for table` error), proven by the negative
--    test in planeSplitP3bDeprivilege.integration.test.ts.
REVOKE ALL ON TABLE events FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE cost_records FROM tanren_dataplane;--> statement-breakpoint

-- 6. Future objects: a table/sequence a LATER migration creates (as the owner
--    `tanren`) is auto-granted to the data-plane role, mirroring `tanren_app`, so
--    a new table needs no extra GRANT bookkeeping. A future write-sensitive table
--    the data plane must NOT write adds its own targeted REVOKE, as above.
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_dataplane;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_dataplane;
