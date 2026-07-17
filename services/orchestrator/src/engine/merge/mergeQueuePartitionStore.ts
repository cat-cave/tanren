// cspell:ignore Unpartitioned
// cspell:ignore unpartitioned
// cspell:ignore Unpartitioned
// Durable, org-scoped partition admission and renewable queue leases. The lease
// lives on the member row (migration 0054); the partition row is the lock boundary.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";
import { MERGE_CLAIM_LEASE_MS } from "./mergeClaimLease.js";

const DEFAULT_TARGET_BRANCH = "main";
const DEFAULT_CAPACITY = 1;
type IsolationReason = "audit_policy" | "member_gate" | "behavior_proof" | "design_proof";

interface PartitionRow {
  id: string;
  scope_key: string;
  mode: "serial" | "scoped" | "isolated";
  generation: number;
}

interface LeaseRow extends PartitionRow {
  org_id: string;
  project_id: string;
  queue_id: string;
  run_id: string;
  spec_id: string;
  pr_url: string;
  pr_number: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  scope_fingerprint: string | null;
}

/** A pre-partition queue row left by an older enqueue path or direct recovery write. */
interface UnpartitionedQueueRow {
  org_id: string;
  project_id: string;
  queue_id: string;
  spec_id: string;
  scope_fingerprint: string | null;
}

export interface MergeQueuePartitionLease {
  partitionId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  generation: number;
  scopeFingerprint?: string;
}

function entryOf(row: LeaseRow): MergeQueueEntry {
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    queueId: row.queue_id,
    runId: row.run_id,
    specId: row.spec_id,
    prUrl: row.pr_url,
    prNumber: Number(row.pr_number),
    dependsOn: [],
    priority: "tbd",
    orderKey: 0,
    partitionId: row.id,
    ...(row.scope_fingerprint === null ? {} : { scopeFingerprint: row.scope_fingerprint }),
  };
}

/**
 * The only write path for `merge_queue_partitions` and queue lease fields. Every
 * method takes a client already inside `runWithOrgScope`; callers cannot cross an
 * org by choosing a different partition id because both queue and partition rows
 * are read under the same RLS transaction.
 */
export class PgMergeQueuePartitionStore {
  constructor(private readonly events?: MergeQueueEventEmitter) {}

  async getOnClient(
    client: pg.PoolClient,
    input: { projectId: string; targetBranch: string; scopeFingerprint: string },
  ): Promise<PartitionRow | null> {
    const result = await client.query<PartitionRow>(
      `SELECT id, scope_key, mode, generation
         FROM merge_queue_partitions
        WHERE project_id = $1 AND target_branch = $2 AND scope_key = $3`,
      [input.projectId, input.targetBranch, input.scopeFingerprint],
    );
    return result.rows[0] ?? null;
  }

  async ensureOnClient(
    client: pg.PoolClient,
    input: {
      orgId: string;
      projectId: string;
      specId: string;
      targetBranch?: string;
      scopeFingerprint?: string;
      mode?: "scoped" | "isolated";
    },
  ): Promise<PartitionRow> {
    const scopeKey = input.scopeFingerprint ?? `spec:${input.specId}`;
    const id = `mqp_${randomUUID()}`;
    const result = await client.query<PartitionRow>(
      `INSERT INTO merge_queue_partitions
         (org_id, project_id, id, target_branch, scope_key, mode, capacity, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (org_id, project_id, target_branch, scope_key)
       DO UPDATE SET scope_key = EXCLUDED.scope_key
       RETURNING id, scope_key, mode, generation`,
      [
        input.orgId,
        input.projectId,
        id,
        input.targetBranch ?? DEFAULT_TARGET_BRANCH,
        scopeKey,
        input.mode ?? "scoped",
        DEFAULT_CAPACITY,
      ],
    );
    const partition = result.rows[0];
    if (partition === undefined) throw new Error(`could not ensure merge partition for ${input.projectId}/${scopeKey}`);
    return partition;
  }

  /** CAS acquire under the partition-row lock; a fresh holder exhausts capacity. */
  async acquireOnClient(client: pg.PoolClient, queueId: string): Promise<MergeQueuePartitionLease | null> {
    // `partition_id` was added after the native queue was already in use, and a few
    // recovery-owned writers deliberately insert the queue row directly. Adopt an
    // active unpartitioned row while holding its row lock before trying to claim it.
    // Without this, the inner join below makes a repair re-drive look like a lease
    // contention forever, which masks a later terminal infra classification too.
    await this.assignPartitionToQueuedEntryOnClient(client, queueId);
    const candidate = await client.query<LeaseRow & { capacity: number; state: string }>(
      `SELECT mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
              mq.scope_fingerprint, p.id, p.scope_key, p.mode, p.generation, p.capacity, p.state,
              mq.lease_owner, mq.lease_expires_at
         FROM merge_queue mq
         JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.queue_id = $1 AND mq.status = 'queued'
        FOR UPDATE OF mq, p`,
      [queueId],
    );
    const row = candidate.rows[0];
    if (row === undefined || row.state !== "active") return null;
    const active = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM merge_queue
        WHERE org_id = $1 AND partition_id = $2 AND status = 'merging'
          AND lease_expires_at > now()`,
      [row.org_id, row.id],
    );
    if (Number(active.rows[0]?.count ?? "0") >= row.capacity) return null;

    const leaseOwner = `mql_${randomUUID()}`;
    const acquired = await client.query<{ lease_expires_at: Date }>(
      `UPDATE merge_queue
          SET status = 'merging', claimed_at = now(), lease_owner = $2,
              lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
        WHERE queue_id = $1 AND status = 'queued'
        RETURNING lease_expires_at`,
      [queueId, leaseOwner, MERGE_CLAIM_LEASE_MS],
    );
    const leaseExpiresAt = acquired.rows[0]?.lease_expires_at;
    if (leaseExpiresAt === undefined) return null;
    const lease: MergeQueuePartitionLease = {
      partitionId: row.id,
      leaseOwner,
      leaseExpiresAt,
      generation: row.generation,
      ...(row.scope_fingerprint === null ? {} : { scopeFingerprint: row.scope_fingerprint }),
    };
    await this.events?.emitPartitionLeased({ projectId: row.project_id, entry: entryOf(row), ...lease });
    return lease;
  }

  /**
   * Atomically assign the default scoped partition to an active row that predates
   * partitioned scheduling. This is intentionally claim-time: only a row that is
   * about to execute is upgraded, and two coordinators cannot assign it twice.
   */
  private async assignPartitionToQueuedEntryOnClient(client: pg.PoolClient, queueId: string): Promise<void> {
    const pending = await client.query<UnpartitionedQueueRow>(
      `SELECT org_id, project_id, queue_id, spec_id, scope_fingerprint
         FROM merge_queue
        WHERE queue_id = $1 AND status = 'queued' AND partition_id IS NULL
        FOR UPDATE`,
      [queueId],
    );
    const row = pending.rows[0];
    if (row === undefined) return;

    const scopeFingerprint = row.scope_fingerprint ?? `spec:${row.spec_id}`;
    const partition = await this.ensureOnClient(client, {
      orgId: row.org_id,
      projectId: row.project_id,
      specId: row.spec_id,
      scopeFingerprint,
    });
    await client.query(
      `UPDATE merge_queue
          SET partition_id = $2, scope_fingerprint = $3
        WHERE queue_id = $1 AND status = 'queued' AND partition_id IS NULL`,
      [row.queue_id, partition.id, scopeFingerprint],
    );
  }

  /** A live holder renews its own lease; a stale/dead owner cannot revive it. */
  async renewOnClient(
    client: pg.PoolClient,
    input: { queueId: string; leaseOwner: string },
  ): Promise<MergeQueuePartitionLease | null> {
    const renewed = await client.query<LeaseRow>(
      `UPDATE merge_queue mq
          SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
         FROM merge_queue_partitions p
        WHERE mq.queue_id = $1 AND mq.org_id = p.org_id AND mq.partition_id = p.id
          AND mq.status = 'merging' AND mq.lease_owner = $2 AND mq.lease_expires_at > now()
        RETURNING mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
                  mq.scope_fingerprint, mq.lease_owner, mq.lease_expires_at, p.id, p.scope_key, p.mode, p.generation`,
      [input.queueId, input.leaseOwner, MERGE_CLAIM_LEASE_MS],
    );
    const row = renewed.rows[0];
    if (row === undefined || row.lease_owner === null || row.lease_expires_at === null) return null;
    return {
      partitionId: row.id,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      generation: row.generation,
      ...(row.scope_fingerprint === null ? {} : { scopeFingerprint: row.scope_fingerprint }),
    };
  }

  /** Yield, settle, or reclaim a holder and append the matching frozen release event. */
  async releaseOnClient(
    client: pg.PoolClient,
    input: { queueId: string; nextStatus: "queued" | "merged" | "dequeued"; reason?: string },
  ): Promise<boolean> {
    const held = await client.query<LeaseRow & { status: string }>(
      `SELECT mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
              mq.scope_fingerprint, mq.lease_owner, mq.lease_expires_at, mq.status,
              p.id, p.scope_key, p.mode, p.generation
         FROM merge_queue mq
         LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.queue_id = $1
        FOR UPDATE OF mq`,
      [input.queueId],
    );
    const row = held.rows[0];
    if (row === undefined || (input.nextStatus === "queued" && row.status !== "merging")) return false;
    await client.query(
      `UPDATE merge_queue
          SET status = $2, dequeue_reason = CASE WHEN $2 = 'dequeued' THEN $3 ELSE dequeue_reason END,
              claimed_at = CASE WHEN $2 = 'queued' THEN NULL ELSE claimed_at END,
              settled_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE queue_id = $1`,
      [input.queueId, input.nextStatus, input.reason ?? null],
    );
    if (row.lease_owner !== null && row.id !== null) {
      await this.events?.emitPartitionReleased({
        projectId: row.project_id,
        entry: entryOf(row),
        partitionId: row.id,
        leaseOwner: row.lease_owner,
        generation: row.generation,
      });
    }
    return true;
  }

  /** Reclaim only expired/malformed leases: a live unexpired holder is never reset. */
  async reclaimExpiredOnClient(client: pg.PoolClient, projectId: string): Promise<number> {
    const expired = await client.query<LeaseRow>(
      `SELECT mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
              mq.scope_fingerprint, mq.lease_owner, mq.lease_expires_at,
              p.id, p.scope_key, p.mode, p.generation
         FROM merge_queue mq
         LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.project_id = $1 AND mq.status = 'merging'
          AND (mq.lease_expires_at IS NULL OR mq.lease_expires_at <= now())
        FOR UPDATE OF mq`,
      [projectId],
    );
    for (const row of expired.rows) {
      await client.query(
        `UPDATE merge_queue
            SET status = 'queued', claimed_at = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE queue_id = $1`,
        [row.queue_id],
      );
      if (row.lease_owner !== null && row.id !== null) {
        await this.events?.emitPartitionReleased({
          projectId: row.project_id,
          entry: entryOf(row),
          partitionId: row.id,
          leaseOwner: row.lease_owner,
          generation: row.generation,
        });
      }
    }
    return expired.rows.length;
  }

  /** Route a poison member to its own partition and release any shared lease first. */
  async isolateOnClient(
    client: pg.PoolClient,
    input: { queueId: string; groupId: string; memberId: string; reason: IsolationReason; findingIds: string[] },
  ): Promise<boolean> {
    const current = await client.query<LeaseRow>(
      `SELECT mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
              mq.scope_fingerprint, mq.lease_owner, mq.lease_expires_at,
              p.id, p.scope_key, p.mode, p.generation
         FROM merge_queue mq
         JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.queue_id = $1 AND mq.status IN ('queued', 'merging')
        FOR UPDATE OF mq, p`,
      [input.queueId],
    );
    const row = current.rows[0];
    if (row === undefined) return false;
    const scopeFingerprint = `isolated:${row.queue_id}`;
    const partition = await this.ensureOnClient(client, {
      orgId: row.org_id,
      projectId: row.project_id,
      specId: row.spec_id,
      targetBranch: DEFAULT_TARGET_BRANCH,
      scopeFingerprint,
      mode: "isolated",
    });
    await client.query(
      `UPDATE merge_queue
          SET partition_id = $2, scope_fingerprint = $3, lease_owner = NULL, lease_expires_at = NULL,
              claimed_at = CASE WHEN status = 'merging' THEN NULL ELSE claimed_at END,
              status = CASE WHEN status = 'merging' THEN 'queued' ELSE status END
        WHERE queue_id = $1`,
      [row.queue_id, partition.id, scopeFingerprint],
    );
    if (row.lease_owner !== null) {
      await this.events?.emitPartitionReleased({
        projectId: row.project_id,
        entry: entryOf(row),
        partitionId: row.id,
        leaseOwner: row.lease_owner,
        generation: row.generation,
      });
    }
    await this.events?.emitMemberIsolated({
      projectId: row.project_id,
      entry: { ...entryOf(row), partitionId: partition.id, scopeFingerprint },
      partitionId: partition.id,
      groupId: input.groupId,
      memberId: input.memberId,
      reason: input.reason,
      findingIds: input.findingIds,
    });
    return true;
  }
}
