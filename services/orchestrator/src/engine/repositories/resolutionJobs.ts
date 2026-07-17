import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ResolutionJob, ResolutionStageKind } from "../contracts/resolutionStage.js";
import { oneOf } from "../data/pgRows.js";
import { nullableText, scalarText } from "../data/scalarText.js";

type QueryClient = Pick<pg.PoolClient, "query">;

const STAGES = ["baseline", "production", "counterfactual", "soak"] as const satisfies readonly ResolutionStageKind[];
const CLAIMABLE_STATES = ["queued", "retryable"] as const;

const JOB_COLUMNS = `
  job.org_id,
  job.project_id,
  job.id,
  job.issue_loop_id,
  job.contract_id,
  job.release_instance_id,
  job.stage,
  job.state,
  job.lease_owner,
  job.lease_expiry,
  job.idempotency_key,
  job.attempt,
  job.prior_attempt_id`;

interface RawResolutionJobRow {
  org_id: unknown;
  project_id: unknown;
  id: unknown;
  issue_loop_id: unknown;
  contract_id: unknown;
  release_instance_id: unknown;
  stage: unknown;
  state: unknown;
  lease_owner: unknown;
  lease_expiry: unknown;
  idempotency_key: unknown;
  attempt: unknown;
  prior_attempt_id: unknown;
}

export interface EnqueueResolutionJobInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly id: string;
  readonly issueLoopId: string;
  readonly contractId: string;
  readonly releaseInstanceId?: string;
  readonly stage: ResolutionStageKind;
  readonly idempotencyKey: string;
  readonly priorAttemptId?: string;
}

export interface EnqueueResolutionJobResult {
  readonly id: string;
  /** False when an earlier enqueue already owns this org-scoped idempotency key. */
  readonly created: boolean;
}

export interface ClaimResolutionJobInput {
  readonly orgId: string;
  readonly leaseOwner: string;
  readonly leaseMs?: number;
}

export interface ClaimResolutionJobByIdInput extends ClaimResolutionJobInput {
  readonly id: string;
}

export interface RenewResolutionJobLeaseInput extends ClaimResolutionJobInput {
  readonly id: string;
}

export interface ReleaseResolutionJobInput {
  readonly orgId: string;
  readonly id: string;
  readonly leaseOwner: string;
  /** A skeleton pass returns work to queued; later stages may use retryable. */
  readonly state?: (typeof CLAIMABLE_STATES)[number];
}

export type RecoverExpiredResolutionJobsInput = ClaimResolutionJobInput;

/** One minute is long enough for a periodic heartbeat to survive a transient delay. */
export const DEFAULT_RESOLUTION_JOB_LEASE_MS = 60_000;

/**
 * Durable, org-scoped persistence for resolution jobs. Every public method opens
 * an RLS transaction for its explicit org; `*OnClient` variants let a caller join
 * an existing scoped transaction when it needs an atomic companion write.
 */
export class ResolutionJobStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async enqueue(input: EnqueueResolutionJobInput): Promise<EnqueueResolutionJobResult> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.enqueueOnClient(client, input));
  }

  public async enqueueOnClient(
    client: QueryClient,
    input: EnqueueResolutionJobInput,
  ): Promise<EnqueueResolutionJobResult> {
    const inserted = await client.query<{ id: unknown }>(
      `INSERT INTO resolution_jobs
         (org_id, project_id, id, issue_loop_id, contract_id, release_instance_id,
          stage, state, idempotency_key, attempt, prior_attempt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, 1, $9)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.orgId,
        input.projectId,
        input.id,
        input.issueLoopId,
        input.contractId,
        input.releaseInstanceId ?? null,
        input.stage,
        input.idempotencyKey,
        input.priorAttemptId ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { id: scalarText(row.id), created: true };

    const existing = await client.query<{ id: unknown }>(
      `SELECT id
         FROM resolution_jobs
        WHERE org_id = $1 AND idempotency_key = $2`,
      [input.orgId, input.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) throw new Error("resolution job enqueue conflict returned no row");
    return { id: scalarText(existingRow.id), created: false };
  }

  /** Atomically lease one queued/retryable job. Concurrent callers skip each other's row locks. */
  public async claimNext(input: ClaimResolutionJobInput): Promise<ResolutionJob | undefined> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.claimNextOnClient(client, input));
  }

  /** Lease this exact queued/retryable job for a synchronous callable command. */
  public async claimById(input: ClaimResolutionJobByIdInput): Promise<ResolutionJob | undefined> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.claimByIdOnClient(client, input));
  }

  public async claimNextOnClient(
    client: QueryClient,
    input: ClaimResolutionJobInput,
  ): Promise<ResolutionJob | undefined> {
    const result = await client.query<RawResolutionJobRow>(
      `WITH candidate AS (
         SELECT org_id, id
           FROM resolution_jobs
          WHERE org_id = $1
            AND state IN ('queued', 'retryable')
          ORDER BY attempt ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE resolution_jobs AS job
          SET state = 'running',
              lease_owner = $2,
              lease_expiry = now() + ($3::bigint * interval '1 millisecond'),
              attempt = job.attempt + 1
         FROM candidate
        WHERE job.org_id = candidate.org_id AND job.id = candidate.id
       RETURNING ${JOB_COLUMNS}`,
      [input.orgId, input.leaseOwner, leaseDuration(input.leaseMs)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeLeasedJob(row);
  }

  public async claimByIdOnClient(
    client: QueryClient,
    input: ClaimResolutionJobByIdInput,
  ): Promise<ResolutionJob | undefined> {
    const result = await client.query<RawResolutionJobRow>(
      `WITH candidate AS (
         SELECT org_id, id
           FROM resolution_jobs
          WHERE org_id = $1 AND id = $2 AND state IN ('queued', 'retryable')
          FOR UPDATE SKIP LOCKED
       )
       UPDATE resolution_jobs AS job
          SET state = 'running',
              lease_owner = $3,
              lease_expiry = now() + ($4::bigint * interval '1 millisecond'),
              attempt = job.attempt + 1
         FROM candidate
        WHERE job.org_id = candidate.org_id AND job.id = candidate.id
       RETURNING ${JOB_COLUMNS}`,
      [input.orgId, input.id, input.leaseOwner, leaseDuration(input.leaseMs)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeLeasedJob(row);
  }

  /** Extend only the lease still owned by this worker. A stale worker gets `false`. */
  public async heartbeat(input: RenewResolutionJobLeaseInput): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.heartbeatOnClient(client, input));
  }

  public async heartbeatOnClient(client: QueryClient, input: RenewResolutionJobLeaseInput): Promise<boolean> {
    const result = await client.query(
      `UPDATE resolution_jobs
          SET lease_expiry = now() + ($4::bigint * interval '1 millisecond')
        WHERE org_id = $1
          AND id = $2
          AND state = 'running'
          AND lease_owner = $3
          AND lease_expiry > now()`,
      [input.orgId, input.id, input.leaseOwner, leaseDuration(input.leaseMs)],
    );
    return result.rowCount === 1;
  }

  /** Return a currently owned lease to the ready set without erasing its attempt evidence. */
  public async release(input: ReleaseResolutionJobInput): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.releaseOnClient(client, input));
  }

  public async releaseOnClient(client: QueryClient, input: ReleaseResolutionJobInput): Promise<boolean> {
    const result = await client.query(
      `UPDATE resolution_jobs
          SET state = $4,
              lease_owner = NULL,
              lease_expiry = NULL
        WHERE org_id = $1
          AND id = $2
          AND state = 'running'
          AND lease_owner = $3`,
      [input.orgId, input.id, input.leaseOwner, input.state ?? "queued"],
    );
    return result.rowCount === 1;
  }

  /** Mark a currently owned lease complete; a late/stale worker cannot complete another owner's job. */
  public async complete(input: Omit<ReleaseResolutionJobInput, "state">): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.completeOnClient(client, input));
  }

  public async completeOnClient(
    client: QueryClient,
    input: Omit<ReleaseResolutionJobInput, "state">,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE resolution_jobs
          SET state = 'completed',
              lease_owner = NULL,
              lease_expiry = NULL
        WHERE org_id = $1
          AND id = $2
          AND state = 'running'
          AND lease_owner = $3`,
      [input.orgId, input.id, input.leaseOwner],
    );
    return result.rowCount === 1;
  }

  /**
   * Crash recovery claims every expired running row directly for `leaseOwner`.
   * `SKIP LOCKED` makes concurrent recovery passes disjoint; the re-leased row
   * stays `running` and its monotonically increasing attempt count records replay.
   */
  public async recoverExpiredLeases(input: RecoverExpiredResolutionJobsInput): Promise<ResolutionJob[]> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.recoverExpiredLeasesOnClient(client, input));
  }

  public async recoverExpiredLeasesOnClient(
    client: QueryClient,
    input: RecoverExpiredResolutionJobsInput,
  ): Promise<ResolutionJob[]> {
    const result = await client.query<RawResolutionJobRow>(
      `WITH expired AS (
         SELECT org_id, id
          FROM resolution_jobs
          WHERE org_id = $1
            AND state = 'running'
            AND lease_expiry <= now()
          ORDER BY lease_expiry ASC, id ASC
          FOR UPDATE SKIP LOCKED
       )
       UPDATE resolution_jobs AS job
          SET lease_owner = $2,
              lease_expiry = now() + ($3::bigint * interval '1 millisecond'),
              attempt = job.attempt + 1
         FROM expired
        WHERE job.org_id = expired.org_id AND job.id = expired.id
       RETURNING ${JOB_COLUMNS}`,
      [input.orgId, input.leaseOwner, leaseDuration(input.leaseMs)],
    );
    return result.rows.map(decodeLeasedJob);
  }
}

function leaseDuration(leaseMs: number | undefined): number {
  const duration = leaseMs ?? DEFAULT_RESOLUTION_JOB_LEASE_MS;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError(`resolution job leaseMs must be a positive safe integer, got ${duration}`);
  }
  return duration;
}

function decodeLeasedJob(row: RawResolutionJobRow): ResolutionJob {
  const leaseOwner = nullableText(row.lease_owner);
  const leaseExpiryValue = row.lease_expiry;
  const releaseInstanceId = nullableText(row.release_instance_id);
  const priorAttemptId = nullableText(row.prior_attempt_id);
  if (leaseOwner === null || leaseExpiryValue === null || leaseExpiryValue === undefined) {
    throw new Error("resolution job claim returned an unleased row");
  }
  return {
    id: scalarText(row.id),
    orgId: scalarText(row.org_id),
    projectId: scalarText(row.project_id),
    issueLoopId: scalarText(row.issue_loop_id),
    contractId: scalarText(row.contract_id),
    ...(releaseInstanceId === null ? {} : { releaseInstanceId }),
    stage: oneOf(row.stage, STAGES, "resolution_jobs.stage"),
    state: scalarText(row.state),
    leaseOwner,
    leaseExpiry: isoTimestamp(leaseExpiryValue),
    idempotencyKey: scalarText(row.idempotency_key),
    attempt: positiveInteger(row.attempt, "resolution_jobs.attempt"),
    ...(priorAttemptId === null ? {} : { priorAttemptId }),
  };
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new TypeError("resolution_jobs.lease_expiry must be a timestamp");
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${context} must be a positive safe integer`);
  }
  return value;
}
