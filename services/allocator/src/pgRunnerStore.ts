import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { volumeNamesFor, type RunnerRecord, type RunnerStore } from "./runnerLifecycle.js";

const allocatorName = "sidecar-docker";

interface RunnerRow {
  runner_id: string;
  run_id: string;
  project_id: string;
  org_id: string;
  container_id: string;
  ssh_host: string;
  ssh_port: number;
  host_key_fingerprint: string;
  image_sha: string;
  created_at: Date;
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
 * The volume names and vault refs are persisted in the `image_sha` companion
 * label-style fields so the abandoned sweeper can wipe them even after the
 * allocator process restarts. Active rows are the ones whose `status` is one of
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
    return {
      runnerId: row.runner_id,
      runId: row.run_id,
      projectId: row.project_id,
      orgId: row.org_id,
      containerId: row.container_id,
      workspaceVolume: volumeNamesFor(row.run_id).workspace,
      codexHomeVolume: volumeNamesFor(row.run_id).codexHome,
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
      hostKeyFingerprint: row.host_key_fingerprint,
      imageSha: row.image_sha,
      vaultRefs: [],
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
  return {
    runnerId: row.runner_id,
    runId: row.run_id,
    projectId: row.project_id,
    orgId: row.org_id,
    containerId: row.container_id,
    workspaceVolume: `${row.container_id}-workspace`,
    codexHomeVolume: `${row.container_id}-codex-home`,
    sshHost: row.ssh_host,
    sshPort: row.ssh_port,
    hostKeyFingerprint: row.host_key_fingerprint,
    imageSha: row.image_sha,
    vaultRefs: [],
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
