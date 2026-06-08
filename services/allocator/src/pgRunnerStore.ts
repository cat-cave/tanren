import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { volumeNamesFor, type RunnerRecord, type RunnerStore } from "./runnerLifecycle.js";

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
 * cross-org SYSTEM service: the abandoned-run sweeper reaps idle runners across
 * ALL tenants and the API `/release` is keyed only by runner_id (no org
 * context), so findActive / markReleased / listActiveOlderThan stay on the
 * system pool where they can see every tenant's rows.
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
    await runWithOrgScope(this.appPool, record.orgId, async (client) => {
      await client.query(
        `INSERT INTO runners (
           runner_id, run_id, project_id, org_id, allocator, status,
           ssh_host, ssh_port, host_key_fingerprint, image_sha, container_id, created_at
         )
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, $10, $11)
         ON CONFLICT (runner_id) DO UPDATE SET
           status = EXCLUDED.status,
           ssh_host = EXCLUDED.ssh_host,
           ssh_port = EXCLUDED.ssh_port,
           host_key_fingerprint = EXCLUDED.host_key_fingerprint,
           image_sha = EXCLUDED.image_sha,
           container_id = EXCLUDED.container_id`,
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
    });
  }

  async markReleased(runnerId: string, reason: string): Promise<RunnerRecord | undefined> {
    // Cross-org system op: release is keyed only by runner_id (the API and the
    // sweeper both reach it without org context), so it runs on the system pool.
    const result = await this.systemPool.query<RunnerRow>(
      `UPDATE runners
       SET status = $2,
           released_at = COALESCE(released_at, now())
       WHERE runner_id = $1
       RETURNING runner_id, run_id, project_id, org_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at`,
      [runnerId, releaseStatusFor(reason)],
    );
    const row = result.rows[0];
    if (row === undefined) {
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

  async listActiveOlderThan(threshold: Date): Promise<RunnerRecord[]> {
    const result = await this.systemPool.query<RunnerRow>(
      `SELECT runner_id, run_id, project_id, org_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at
       FROM runners
       WHERE released_at IS NULL AND created_at < $1`,
      [threshold],
    );
    return result.rows.map(materialize);
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
  if (reason === "abandoned") {
    return "abandoned";
  }
  if (reason === "failed") {
    return "failed";
  }
  return "released";
}
