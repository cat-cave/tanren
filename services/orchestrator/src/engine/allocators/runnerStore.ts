import type pg from "pg";
import { withJobOrgScope } from "../data/orgScopedDb.js";

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
    // RLS R3a-worker (runners write): the allocator runs OUTSIDE an open
    // connection scope — the worker holds only the lightweight per-job org-id
    // (`runWithJobOrgId`, no connection across the run's minutes of I/O), so a
    // `resolveWritableClient` seam (which only finds an OPEN connection scope)
    // would fall through to the bare pool and the enforced `tanren_app` policy
    // rejects the unscoped INSERT (`new row violates row-level security policy
    // for table "runners"`). Routing through `withJobOrgScope` opens a SHORT
    // `runWithOrgScope` from the per-job org-id for THIS statement, so the
    // INSERT carries `app.current_org_id` and the policy admits the run's own
    // runner row. With no job-org-id (a legacy/unscoped run) it falls through to
    // the pool — behavior-identical to before RLS.
    await withJobOrgScope(this.pool, (client) =>
      client.query(
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
