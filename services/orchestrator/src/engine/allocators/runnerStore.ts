import type pg from "pg";

export interface ClaimRunnerInput {
  runnerId: string;
  runId: string;
  projectId: string;
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
    await this.pool.query(
      `INSERT INTO runners (
         runner_id, run_id, project_id, allocator, status, ssh_host, ssh_port,
         host_key_fingerprint, image_sha, container_id
       )
       VALUES ($1, $2, $3, $4, 'claimed', $5, $6, $7, $8, $9)`,
      [
        input.runnerId,
        input.runId,
        input.projectId,
        input.allocator,
        input.sshHost,
        input.sshPort,
        input.hostKeyFingerprint,
        input.imageSha,
        input.containerId,
      ],
    );
  }

  async release(runnerId: string): Promise<void> {
    await this.pool.query("UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1", [
      runnerId,
    ]);
  }
}
