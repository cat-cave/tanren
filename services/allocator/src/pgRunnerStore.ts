import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import {
  volumeNamesFor,
  type AllocationAudit,
  type RunnerReclaimReason,
  type RunnerRecord,
  type RunnerStore,
  type StuckRunner,
  type StuckThresholds,
  type SweptAudit,
} from "./runnerLifecycle.js";
import { recordAllocatedEvent, recordSweptEvent } from "./pgAllocatorEvents.js";

const allocatorName = "sidecar-docker";

interface RunnerRow {
  runner_id: string;
  // Nullable: a runless Forge ideation runner persists run_id/project_id as NULL
  // (no FK target). The naming handle is recovered from runner_id, not these.
  run_id: string | null;
  project_id: string | null;
  org_id: string;
  container_id: string;
  ssh_host: string;
  ssh_port: number;
  host_key_fingerprint: string;
  image_sha: string;
  created_at: Date;
}

// The runner id is `runner_<handle>` (see RunnerLifecycle.allocate). The handle
// is the stable naming token volume names derive from, recoverable even when the
// persisted run_id column is NULL (runless Forge ideation).
function handleFromRunnerId(runnerId: string): string {
  return runnerId.startsWith("runner_") ? runnerId.slice("runner_".length) : runnerId;
}

/**
 * Postgres-backed runner store used by the allocator sidecar.
 *
 * `runners` is a TENANT table (org_id NOT NULL + RLS, migration 0030). De-priv:
 * the per-run INSERT runs under the run's org scope on a RESTRICTED app-role
 * pool (`runWithOrgScope`), so the row is written WITHIN RLS — not off-RLS via
 * the BYPASSRLS `tanren_system` role. The allocator is also a genuinely
 * cross-org SYSTEM service: the abandoned-run sweeper reaps DEAD-DRIVER runners
 * across ALL tenants (sign-of-life, not age) and the API `/release` is keyed only
 * by runner_id (no org context), so findActive / markReleased / listStuck stay on
 * the system pool where they can see every tenant's rows.
 *
 * The volume names are derived from the naming handle (not persisted as columns)
 * so the abandoned sweeper can wipe them even after the allocator process
 * restarts. Active rows are the ones whose `status` is one of
 * the in-flight values; releasing flips the row to `released` and stamps
 * `released_at`.
 */
export class PgRunnerStore implements RunnerStore {
  constructor(
    private readonly systemPool: pg.Pool,
    private readonly appPool: pg.Pool,
  ) {}

  async insert(record: RunnerRecord): Promise<void> {
    // De-priv: write the tenant `runners` row INSIDE the run's org RLS scope.
    //
    // Never overwrite a LIVE container_id (fix #3). The runner id is the
    // deterministic `runner_<handle>`, so a retried allocate collides on the
    // unique runner_id. A bare `ON CONFLICT DO UPDATE` would overwrite a
    // still-running container's id → orphan it (unreferenced → unsweepable, the
    // 204GB-leak class). The `WHERE runners.released_at IS NOT NULL` predicate
    // restricts the UPDATE to RE-allocating an already-released runner id; a
    // genuine LIVE conflict updates zero rows and inserts zero rows, which we
    // detect (rowCount===0) and reject LOUD — never silently overwrite.
    // (The lifecycle pre-checks findActive and short-circuits before reaching
    // here on a live row; this is the fail-closed backstop at the DB seam.)
    await runWithOrgScope(this.appPool, record.orgId, async (client) => {
      const result = await client.query(
        `INSERT INTO runners (
           runner_id, run_id, project_id, org_id, allocator, status,
           ssh_host, ssh_port, host_key_fingerprint, image_sha, container_id, created_at
         )
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, $10, $11)
         ON CONFLICT (runner_id) DO UPDATE SET
           status = EXCLUDED.status,
           run_id = EXCLUDED.run_id,
           project_id = EXCLUDED.project_id,
           org_id = EXCLUDED.org_id,
           ssh_host = EXCLUDED.ssh_host,
           ssh_port = EXCLUDED.ssh_port,
           host_key_fingerprint = EXCLUDED.host_key_fingerprint,
           image_sha = EXCLUDED.image_sha,
           container_id = EXCLUDED.container_id,
           created_at = EXCLUDED.created_at,
           released_at = NULL
         WHERE runners.released_at IS NOT NULL`,
        [
          record.runnerId,
          record.runId,
          record.projectId,
          record.orgId,
          allocatorName,
          record.sshHost,
          record.sshPort,
          record.hostKeyFingerprint,
          record.imageSha,
          record.containerId,
          record.createdAt,
        ],
      );
      if (result.rowCount === 0) {
        // A row already exists for this runner_id and it is LIVE (released_at IS
        // NULL), so the conditional UPDATE matched nothing. Fail LOUD rather than
        // silently overwriting a live container_id.
        throw new Error(
          `allocator: runner ${record.runnerId} already has a LIVE row (released_at IS NULL); refusing to overwrite its container_id`,
        );
      }
    });
  }

  async recordAllocated(audit: AllocationAudit): Promise<void> {
    // The durable audit event goes through the allocator's SOLE events writer
    // (pgAllocatorEvents — the per-service single-writer seam), org-scoped on the
    // restricted app-role pool (same RLS scope as the `runners` row).
    await recordAllocatedEvent(this.appPool, audit);
  }

  async markReleased(runnerId: string, reason: string): Promise<RunnerRecord | undefined> {
    // Cross-org system op: release is keyed only by runner_id (the API and the
    // sweeper both reach it without org context), so it runs on the system pool.
    //
    // Atomic CLAIM (fix #2): the `AND released_at IS NULL` predicate makes this
    // UPDATE the single gate for Docker teardown. Two concurrent release() calls
    // race here; exactly ONE matches the still-active row (rowCount===1, returns
    // the record), the other matches zero rows (rowCount===0, returns undefined
    // → the caller does NO teardown). So the container+volumes are torn down once.
    const result = await this.systemPool.query<RunnerRow>(
      `UPDATE runners
       SET status = $2,
           released_at = now()
       WHERE runner_id = $1 AND released_at IS NULL
       RETURNING runner_id, run_id, project_id, org_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at`,
      [runnerId, releaseStatusFor(reason)],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Already released by a concurrent caller (or never existed): not our claim.
      return undefined;
    }
    const handle = handleFromRunnerId(row.runner_id);
    return {
      runnerId: row.runner_id,
      runId: row.run_id,
      projectId: row.project_id,
      handle,
      orgId: row.org_id,
      containerId: row.container_id,
      // Volume names derive from the naming HANDLE (not the possibly-NULL run_id).
      workspaceVolume: volumeNamesFor(handle).workspace,
      codexHomeVolume: volumeNamesFor(handle).codexHome,
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
      hostKeyFingerprint: row.host_key_fingerprint,
      imageSha: row.image_sha,
      createdAt: row.created_at,
      released: true,
    };
  }

  async findActive(runnerId: string): Promise<RunnerRecord | undefined> {
    const result = await this.systemPool.query<RunnerRow>(
      `SELECT runner_id, run_id, project_id, org_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at
       FROM runners
       WHERE runner_id = $1 AND released_at IS NULL`,
      [runnerId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return materialize(row);
  }

  async listStuck(thresholds: StuckThresholds): Promise<StuckRunner[]> {
    // Cross-org SYSTEM read (the sweeper reconciles across ALL tenants), so this
    // runs on the BYPASSRLS system pool — same scope rationale as the abandoned
    // sweep / runner_id-keyed release.
    //
    // ABANDONMENT IS SIGN-OF-LIFE BASED, NOT WALL-CLOCK BASED. The query returns
    // ONLY runners in a genuine STUCK state, each tagged with the discriminated
    // reason; a HEALTHY in-flight runner — owning run non-terminal AND its worker
    // still holding a LIVE job lease — matches none of the predicates and is NEVER
    // returned, no matter how long the build has been running. A 6h (or 60h) live
    // build is left alone; only a DEAD driver is reaped.
    //
    //   - `live_job` (the CTE): per run, is there ANY live sign of life — a
    //     queued/claimed job (about to run / mid-handoff) OR a `running` job whose
    //     `leased_until` is still in the future (the worker is heartbeating). A run
    //     with a live job is ALIVE.
    //   - LEFT JOINs keep a runner whose run row / job row is absent (the run-less /
    //     wedged path, and the pre-first-heartbeat handoff window).
    //
    // Reason precedence (the CASE picks the FIRST matching, mirroring the WHERE):
    //   1. terminal_run  — run_id set AND the joined run is in a TERMINAL status.
    //   2. lease_lapsed  — run_id set, NOT terminal, NO live job (the worker stopped
    //                      heartbeating → dead driver), AND the runner is past the
    //                      allocate→first-heartbeat handoff window (so a just-allocated
    //                      runner whose first lease has not landed yet is not reaped).
    //   3. unclaimed_grace — run_id IS NULL (never tied to a live run) AND older than
    //                        the grace window (a wedged allocation).
    const result = await this.systemPool.query<RunnerRow & { reason: RunnerReclaimReason }>(
      `WITH live_job AS (
         SELECT run_id
         FROM job_queue
         WHERE run_id IS NOT NULL
           AND (
             status IN ('queued','claimed')
             OR (status = 'running' AND leased_until IS NOT NULL AND leased_until >= $1)
           )
         GROUP BY run_id
       )
       SELECT r.runner_id, r.run_id, r.project_id, r.org_id, r.container_id, r.ssh_host, r.ssh_port,
              r.host_key_fingerprint, r.image_sha, r.created_at,
              CASE
                WHEN run.status IN ('completed','failed','halted','cancelled') THEN 'terminal_run'
                WHEN r.run_id IS NOT NULL THEN 'lease_lapsed'
                ELSE 'unclaimed_grace'
              END AS reason
       FROM runners r
       LEFT JOIN runs run ON run.run_id = r.run_id
       LEFT JOIN live_job lj ON lj.run_id = r.run_id
       WHERE r.released_at IS NULL
         AND (
           run.status IN ('completed','failed','halted','cancelled')
           OR (r.run_id IS NOT NULL AND lj.run_id IS NULL AND r.created_at < $2)
           OR (r.run_id IS NULL AND r.created_at < $2)
         )`,
      [thresholds.now, thresholds.graceThreshold],
    );
    return result.rows.map((row) => ({ record: materialize(row), reason: row.reason }));
  }

  async recordSwept(audit: SweptAudit): Promise<void> {
    // The durable reclaim audit goes through the allocator's SOLE events writer,
    // org-scoped on the restricted app-role pool (same RLS scope as the `runners`
    // row), so a leak the per-run `finally` missed is never reclaimed silently.
    await recordSweptEvent(this.appPool, audit);
  }
}

function materialize(row: RunnerRow): RunnerRecord {
  const handle = handleFromRunnerId(row.runner_id);
  return {
    runnerId: row.runner_id,
    runId: row.run_id,
    projectId: row.project_id,
    handle,
    orgId: row.org_id,
    containerId: row.container_id,
    // Volume names derive from the naming HANDLE — the same `volumeNamesFor`
    // basis `allocate` created them with — so release/sweep wipe the right
    // volumes even for a runless runner whose run_id column is NULL.
    workspaceVolume: volumeNamesFor(handle).workspace,
    codexHomeVolume: volumeNamesFor(handle).codexHome,
    sshHost: row.ssh_host,
    sshPort: row.ssh_port,
    hostKeyFingerprint: row.host_key_fingerprint,
    imageSha: row.image_sha,
    createdAt: row.created_at,
    released: false,
  };
}

function releaseStatusFor(reason: string): string {
  // Every sweeper reclaim path (lease-lapsed/wedged/terminal-run) lands the `abandoned`
  // status — a swept runner is an abandoned one regardless of the discriminated
  // cause carried in the reason string.
  if (reason.startsWith("abandoned")) {
    return "abandoned";
  }
  if (reason === "failed") {
    return "failed";
  }
  return "released";
}
