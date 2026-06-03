import type pg from "pg";
import { withJobOrgScope } from "../data/orgScopedDb.js";

export interface ClaimRunnerInput {
  runnerId: string;
  /**
   * The value written to `runners.run_id` (FK → `runs`). `null` for a RUNLESS
   * Forge ideation allocation, whose synthetic handle is NOT a row in `runs` —
   * persisting it would violate `runners_run_id_runs_run_id_fk`. `runners.run_id`
   * is nullable, so NULL is the correct "no run" value. The synthetic handle is
   * still used by the allocator for runner/container naming; only the DB column
   * is NULL.
   */
  runId: string | null;
  /**
   * The value written to `runners.project_id` (FK → `projects`). `null` for a
   * project-less Forge ideation allocation (e.g. the greenfield interview, which
   * runs before any project exists) — the same FK reasoning as `runId`.
   */
  projectId: string | null;
  /**
   * The org the runner belongs to — the CALLER's org, threaded EXPLICITLY so the
   * `runners` row carries a valid tenant org_id even for a RUNLESS allocation (a
   * Forge ideation runner whose `runId` is a synthetic, non-`runs` handle). This
   * was previously derived in-statement from `(SELECT org_id FROM runs WHERE
   * run_id = $runId)`, which returns NULL for that runless handle and made the
   * org-scoped INSERT violate the `runners` WITH CHECK policy (the apex onboarding
   * interview 500'd here). `null` is the EXPLICIT legacy/unscoped-run case (the
   * worker's system scope / BYPASSRLS), NOT a missing value.
   */
  orgId: string | null;
  allocator: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
  containerId: string;
}

export interface RunnerStore {
  claim(input: ClaimRunnerInput): Promise<void>;
  release(runnerId: string): Promise<void>;
}

export class PgRunnerStore implements RunnerStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(input: ClaimRunnerInput): Promise<void> {
    // RLS R3a-worker (runners write): the allocator runs OUTSIDE an open
    // connection scope — the worker holds only the lightweight per-job org-id
    // (`runWithJobOrgId`, no connection across the run's minutes of I/O), so a
    // `resolveWritableClient` seam (which only finds an OPEN connection scope)
    // would fall through to the bare pool and the enforced `tanren_app` policy
    // rejects the unscoped INSERT (`new row violates row-level security policy
    // for table "runners"`). Routing through `withJobOrgScope` opens a SHORT
    // `runWithOrgScope` from the per-job org-id for THIS statement, so the
    // INSERT carries `app.current_org_id` and the policy admits the run's own
    // runner row. A legacy/unscoped run (org_id NULL) runs under the worker's
    // per-job SYSTEM scope, so this routes through a short `runWithSystemScope`
    // (BYPASSRLS) instead — never an implicit unscoped bare-pool write.
    await withJobOrgScope(this.pool, (client) =>
      client.query(
        // org_id is mandatory (tanren tenancy hardening) and is the CALLER's org,
        // passed EXPLICITLY ($4) — NOT derived from a `(SELECT org_id FROM runs
        // …)` subquery. A RUNLESS Forge allocation has a synthetic `runId` with no
        // matching `runs` row, so that subquery returned NULL and the org-scoped
        // INSERT violated the runners WITH CHECK policy. The runner's org is the
        // org the allocate request belongs to, full stop. `null` is the explicit
        // legacy/unscoped-run case, written under the worker's BYPASSRLS scope.
        //
        // run_id ($2) and project_id ($3) are likewise the EXPLICIT values, and
        // are NULL for a runless / project-less Forge ideation allocation — both
        // columns are nullable, so NULL avoids the run_id→runs / project_id→projects
        // FK violations the synthetic handle would otherwise cause.
        `INSERT INTO runners (
           runner_id, run_id, project_id, org_id, allocator, status, ssh_host, ssh_port,
           host_key_fingerprint, image_sha, container_id
         )
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, $10)`,
        [
          input.runnerId,
          input.runId,
          input.projectId,
          input.orgId,
          input.allocator,
          input.sshHost,
          input.sshPort,
          input.hostKeyFingerprint,
          input.imageSha,
          input.containerId,
        ],
      ),
    );
  }

  async release(runnerId: string): Promise<void> {
    // RLS R3a-worker (runners write): same per-job-org-id seam as `claim` —
    // the release runs under the worker's `runWithJobOrgId` (no open connection
    // scope), so it opens a SHORT org-scoped txn for this UPDATE.
    await withJobOrgScope(this.pool, (client) =>
      client.query("UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1", [runnerId]),
    );
  }
}
