import type { ResolutionJobRecord, MemoryDb, QueryResult } from "./conformanceMemoryDb.js";

function copy(row: ResolutionJobRecord): ResolutionJobRecord {
  return { ...row, lease_expiry: row.lease_expiry === null ? null : new Date(row.lease_expiry) };
}

/**
 * Lane-owned SQL handler for the frozen resolution_jobs memory stub. Its visible
 * slice is the current org, matching the database's deny-by-default RLS policy.
 */
export class ResolutionJobScopedClient {
  public constructor(
    private readonly db: MemoryDb,
    private readonly orgId: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  public async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const result = this.resolutionJobSql(sql, params);
    if (result === undefined) throw new Error(`ResolutionJobMemoryDb: unrecognized SQL: ${sql}`);
    return result;
  }

  private resolutionJobSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (sql.startsWith("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id FROM resolution_jobs") && sql.includes("idempotency_key = $2")) {
      const [orgId, idempotencyKey] = params as [string, string];
      const row = this.visible().find((job) => job.org_id === orgId && job.idempotency_key === idempotencyKey);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO resolution_jobs")) return this.enqueue(params);
    if (sql.startsWith("WITH candidate AS")) return this.claim(params);
    if (sql.startsWith("WITH expired AS")) return this.recover(params);
    if (sql.startsWith("UPDATE resolution_jobs SET lease_expiry = $4")) return this.heartbeat(params);
    if (sql.startsWith("UPDATE resolution_jobs SET state = $4")) return this.release(params);
    if (sql.startsWith("UPDATE resolution_jobs SET state = 'completed'")) return this.complete(params);
    if (sql.startsWith("SELECT id FROM resolution_jobs") && sql.includes("ORDER BY id")) {
      const [orgId] = params as [string];
      const rows = this.visible()
        .filter((job) => job.org_id === orgId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((job) => ({ id: job.id }));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }

  private enqueue(params: readonly unknown[]): QueryResult {
    const [orgId, projectId, id, issueLoopId, contractId, releaseInstanceId, stage, idempotencyKey, priorAttemptId] =
      params as [string, string, string, string, string, string | null, string, string, string | null];
    if (orgId !== this.orgId) return { rows: [], rowCount: 0 };
    const row: ResolutionJobRecord = {
      org_id: orgId,
      project_id: projectId,
      id,
      issue_loop_id: issueLoopId,
      contract_id: contractId,
      release_instance_id: releaseInstanceId,
      stage,
      state: "queued",
      lease_owner: null,
      lease_expiry: null,
      idempotency_key: idempotencyKey,
      attempt: 1,
      prior_attempt_id: priorAttemptId,
    };
    this.db.resolutionJobs.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  private claim(params: readonly unknown[]): QueryResult {
    const [orgId, leaseOwner, expiry] = params as [string, string, Date];
    const row = this.visible()
      .filter((job) => job.org_id === orgId && (job.state === "queued" || job.state === "retryable"))
      .sort((left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id))[0];
    if (row === undefined) return { rows: [], rowCount: 0 };
    row.state = "running";
    row.lease_owner = leaseOwner;
    row.lease_expiry = new Date(expiry);
    row.attempt += 1;
    return { rows: [copy(row)], rowCount: 1 };
  }

  private recover(params: readonly unknown[]): QueryResult {
    const [orgId, observedAt, leaseOwner, expiry] = params as [string, Date, string, Date];
    const rows = this.visible()
      .filter(
        (job) =>
          job.org_id === orgId &&
          job.state === "running" &&
          job.lease_expiry !== null &&
          job.lease_expiry.getTime() <= observedAt.getTime(),
      )
      .sort(
        (left, right) =>
          (left.lease_expiry?.getTime() ?? 0) - (right.lease_expiry?.getTime() ?? 0) || left.id.localeCompare(right.id),
      );
    rows.forEach((row) => {
      row.lease_owner = leaseOwner;
      row.lease_expiry = new Date(expiry);
      row.attempt += 1;
    });
    return { rows: rows.map((row) => copy(row)), rowCount: rows.length };
  }

  private heartbeat(params: readonly unknown[]): QueryResult {
    const [orgId, id, leaseOwner, expiry] = params as [string, string, string, Date];
    const row = this.visible().find(
      (job) => job.org_id === orgId && job.id === id && job.state === "running" && job.lease_owner === leaseOwner,
    );
    if (row === undefined) return { rows: [], rowCount: 0 };
    row.lease_expiry = new Date(expiry);
    return { rows: [], rowCount: 1 };
  }

  private release(params: readonly unknown[]): QueryResult {
    const [orgId, id, leaseOwner, state] = params as [string, string, string, string];
    const row = this.visible().find(
      (job) => job.org_id === orgId && job.id === id && job.state === "running" && job.lease_owner === leaseOwner,
    );
    if (row === undefined) return { rows: [], rowCount: 0 };
    row.state = state;
    row.lease_owner = null;
    row.lease_expiry = null;
    return { rows: [], rowCount: 1 };
  }

  private complete(params: readonly unknown[]): QueryResult {
    const [orgId, id, leaseOwner] = params as [string, string, string];
    const row = this.visible().find(
      (job) => job.org_id === orgId && job.id === id && job.state === "running" && job.lease_owner === leaseOwner,
    );
    if (row === undefined) return { rows: [], rowCount: 0 };
    row.state = "completed";
    row.lease_owner = null;
    row.lease_expiry = null;
    return { rows: [], rowCount: 1 };
  }

  private visible(): ResolutionJobRecord[] {
    return this.db.resolutionJobs.filter((job) => job.org_id === this.orgId);
  }
}
