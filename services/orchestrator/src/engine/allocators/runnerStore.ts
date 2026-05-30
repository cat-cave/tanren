import type pg from "pg";
import { resolveWritableClient } from "../data/orgScopedDb.js";

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
    // RLS R2 cohort-3 (runners write): route the runner-claim INSERT through the
    // ambient org-scoped client when one is open (the allocation runs inside the
    // worker's per-job org context), falling back to the pool otherwise. Inert
    // in R1 (no policies); same committed row either way.
    await resolveWritableClient(this.pool).query(
      // org_id is mandatory (tanren tenancy hardening); derive it from the
      // run this runner is claimed for so the runner row is tenant-scoped.
      `INSERT INTO runners (
         runner_id, run_id, project_id, org_id, allocator, status, ssh_host, ssh_port,
         host_key_fingerprint, image_sha, container_id
       )
       VALUES ($1, $2, $3, (SELECT org_id FROM runs WHERE run_id = $2), $4, 'claimed', $5, $6, $7, $8, $9)`,
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
    // RLS R2 cohort-3 (runners write): same pool-or-scope seam as `claim`.
    await resolveWritableClient(this.pool).query(
      "UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1",
      [runnerId],
    );
  }
}
