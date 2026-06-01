-- Custom SQL migration file, put your code below! --

-- Plane-split P3c: the SECOND de-privilege cutover for the `tanren_dataplane`
-- runtime role — the run/spec/task LIFECYCLE writes.
--
-- P3b (migration 0031) routed the worker's `events` + `cost_records` writes
-- through the control-plane `/internal/*` endpoints over mTLS and DROPPED those
-- write grants. But the workflow STILL wrote `runs` (the `running` transition +
-- pr_url), `specs` (`in_flight` / merge-outcome status), and `tasks` (the
-- subtask / CI / review / merge lifecycle rows) DIRECTLY under its own role —
-- 0031's own comment flagged this for "a later wave". P3c is that wave: the
-- workflow + worker now route EVERY non-finalize `runs` / `specs` / `tasks`
-- write through the new `/internal/set-run-status`, `/internal/set-run-pr-url`,
-- `/internal/set-spec-status`, `/internal/supersede-queued-planner-task`,
-- `/internal/insert-task`, and `/internal/update-task` endpoints (the finalize
-- already went through `/internal/finalize-run` in P3a). So with remote-writes
-- ON the data plane writes NONE of these three tables directly, and we DROP its
-- remaining write grants here.
--
-- What the role KEEPS vs. LOSES (the honest per-table audit, like 0031):
--   * runs   — KEEP SELECT (the worker reads the run row to drive the loop +
--              resolve context), DROP INSERT/UPDATE/DELETE. (Run rows are
--              CREATED by the control plane's spec-run trigger under `tanren_app`,
--              never by the data plane.)
--   * specs  — KEEP SELECT (context load reads the spec), DROP writes. (Specs are
--              created/edited by the control-plane API under `tanren_app`.)
--   * tasks  — KEEP SELECT (the CI/review/merge `ensure*Task` helpers read the
--              latest task row, and the dashboard reads tasks), DROP writes. The
--              task INSERT/UPDATE now go remote.
--
-- The IN-PROCESS worker (dev default, remote-writes OFF) connects as its own
-- (non-dataplane) role and keeps writing these tables directly via the
-- `DirectRunStateWriter` / inline path — this REVOKE only bites the standalone
-- `tanren_dataplane` runtime. `job_queue` and the other cross-org system tables
-- stay OUTSIDE RLS; the role keeps them (the supersede's `job_queue` cancel still
-- runs in-process).
--
-- Migrations keep running as the OWNER (`tanren`). Idempotent: a REVOKE of an
-- already-absent grant is a no-op, so re-running the full set must not error.

-- The de-privilege. Drop the WRITES on the three lifecycle tables, keep SELECT
-- (the data plane legitimately reads all three to drive + contextualize the run).
-- With remote-writes ON these writes go through the control plane, so dropping
-- the grant is the security payoff: a direct write by this role is now rejected
-- by Postgres (a `permission denied for table` / 42501 error), proven by the
-- negative test in planeSplitP3cDeprivilege.integration.test.ts.
REVOKE INSERT, UPDATE, DELETE ON TABLE runs FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE specs FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE tasks FROM tanren_dataplane;
