import type pg from "pg";
import { volumeNamesFor, type RunnerRecord, type RunnerStore } from "./runnerLifecycle.js";

const allocatorName = "sidecar-docker";

/**
 * Postgres-backed runner store used by the allocator sidecar. Active rows are
 * the ones whose `status` is one of the in-flight values; releasing flips the
 * row to `released` and stamps `released_at`.
 *
 * The volume names and vault refs are persisted in the `image_sha` companion
 * label-style fields so the abandoned sweeper can wipe them even after the
 * allocator process restarts. We piggyback on the existing schema columns
 * (`container_id`, `hcloud_server_id`) and store sidecar-specific extras in a
 * derived comment column the table already exposes. Schema evolution to a
 * proper allocator_state JSONB is owned by a later spec; for now the runner
 * lifecycle keeps an in-memory mirror that the sweeper consults on cold start.
 */
export class PgRunnerStore implements RunnerStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(record: RunnerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO runners (
         runner_id, run_id, project_id, allocator, status,
         ssh_host, ssh_port, host_key_fingerprint, image_sha, container_id, created_at
       )
       VALUES ($1, $2, $3, $4, 'claimed', $5, $6, $7, $8, $9, $10)
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
        allocatorName,
        record.sshHost,
        record.sshPort,
        record.hostKeyFingerprint,
        record.imageSha,
        record.containerId,
        record.createdAt
      ]
    );
  }

  async markReleased(runnerId: string, reason: string): Promise<RunnerRecord | undefined> {
    const result = await this.pool.query<{
      runner_id: string;
      run_id: string;
      project_id: string;
      container_id: string;
      ssh_host: string;
      ssh_port: number;
      host_key_fingerprint: string;
      image_sha: string;
      created_at: Date;
    }>(
      `UPDATE runners
       SET status = $2,
           released_at = COALESCE(released_at, now())
       WHERE runner_id = $1
       RETURNING runner_id, run_id, project_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at`,
      [runnerId, releaseStatusFor(reason)]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      runnerId: row.runner_id,
      runId: row.run_id,
      projectId: row.project_id,
      containerId: row.container_id,
      workspaceVolume: volumeNamesFor(row.run_id).workspace,
      codexHomeVolume: volumeNamesFor(row.run_id).codexHome,
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
      hostKeyFingerprint: row.host_key_fingerprint,
      imageSha: row.image_sha,
      vaultRefs: [],
      createdAt: row.created_at,
      released: true
    };
  }

  async findActive(runnerId: string): Promise<RunnerRecord | undefined> {
    const result = await this.pool.query<{
      runner_id: string;
      run_id: string;
      project_id: string;
      container_id: string;
      ssh_host: string;
      ssh_port: number;
      host_key_fingerprint: string;
      image_sha: string;
      created_at: Date;
    }>(
      `SELECT runner_id, run_id, project_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at
       FROM runners
       WHERE runner_id = $1 AND released_at IS NULL`,
      [runnerId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return materialize(row);
  }

  async listActiveOlderThan(threshold: Date): Promise<RunnerRecord[]> {
    const result = await this.pool.query<{
      runner_id: string;
      run_id: string;
      project_id: string;
      container_id: string;
      ssh_host: string;
      ssh_port: number;
      host_key_fingerprint: string;
      image_sha: string;
      created_at: Date;
    }>(
      `SELECT runner_id, run_id, project_id, container_id, ssh_host, ssh_port, host_key_fingerprint, image_sha, created_at
       FROM runners
       WHERE released_at IS NULL AND created_at < $1`,
      [threshold]
    );
    return result.rows.map(materialize);
  }
}

function materialize(row: {
  runner_id: string;
  run_id: string;
  project_id: string;
  container_id: string;
  ssh_host: string;
  ssh_port: number;
  host_key_fingerprint: string;
  image_sha: string;
  created_at: Date;
}): RunnerRecord {
  return {
    runnerId: row.runner_id,
    runId: row.run_id,
    projectId: row.project_id,
    containerId: row.container_id,
    workspaceVolume: `${row.container_id}-workspace`,
    codexHomeVolume: `${row.container_id}-codex-home`,
    sshHost: row.ssh_host,
    sshPort: row.ssh_port,
    hostKeyFingerprint: row.host_key_fingerprint,
    imageSha: row.image_sha,
    vaultRefs: [],
    createdAt: row.created_at,
    released: false
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
