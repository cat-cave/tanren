// cspell:ignore ssync

import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const SOURCE_SYNC_STATES = ["pending", "sent", "verified", "externally_closed_unverified"] as const;
export type SourceSyncState = (typeof SOURCE_SYNC_STATES)[number];

export interface SourceSyncOutboxRow {
  orgId: string;
  id: string;
  issueLoopId: string;
  sourceId: string;
  operation: string;
  state: SourceSyncState;
  payloadHash: string;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
}

export interface EnqueueSourceSyncInput {
  orgId: string;
  issueLoopId: string;
  sourceId: string;
  operation: string;
  payload: unknown;
}

export interface SourceSyncClaimInput {
  id: string;
  workerId: string;
  leaseMs: number;
}

export interface EnqueueSourceSyncResult {
  row: SourceSyncOutboxRow;
  inserted: boolean;
}

interface SourceSyncRow {
  org_id: string;
  id: string;
  issue_loop_id: string;
  source_id: string;
  operation: string;
  state: string;
  payload_hash: string;
  claim_owner: string | null;
  claim_expires_at: Date | string | null;
  created_at: Date | string;
}

const State = z.enum(SOURCE_SYNC_STATES);
const COLUMNS = `org_id, id, issue_loop_id, source_id, operation, state, payload_hash,
 claim_owner, claim_expires_at, created_at`;

function date(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function mapRow(row: SourceSyncRow): SourceSyncOutboxRow {
  return {
    orgId: row.org_id,
    id: row.id,
    issueLoopId: row.issue_loop_id,
    sourceId: row.source_id,
    operation: row.operation,
    state: State.parse(row.state),
    payloadHash: row.payload_hash,
    claimOwner: row.claim_owner,
    claimExpiresAt: date(row.claim_expires_at),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function sourceSyncPayloadHash(input: EnqueueSourceSyncInput): string {
  return `sha256:${createHash("sha256")
    .update(canonical({ issueLoopId: input.issueLoopId, operation: input.operation, payload: input.payload }))
    .digest("hex")}`;
}

function deterministicId(input: EnqueueSourceSyncInput, payloadHash: string): string {
  return `ssync_${createHash("sha256")
    .update(`${input.orgId}:${input.issueLoopId}:${input.sourceId}:${input.operation}:${payloadHash}`)
    .digest("hex")}`;
}

export const SourceSyncOutboxStore = {
  async enqueue(client: QueryClient, input: EnqueueSourceSyncInput): Promise<SourceSyncOutboxRow> {
    return (await SourceSyncOutboxStore.enqueueWithOutcome(client, input)).row;
  },

  async enqueueWithOutcome(client: QueryClient, input: EnqueueSourceSyncInput): Promise<EnqueueSourceSyncResult> {
    const payloadHash = sourceSyncPayloadHash(input);
    const id = deterministicId(input, payloadHash);
    const inserted = await client.query<SourceSyncRow>(
      `INSERT INTO source_sync_outbox
         (org_id, id, issue_loop_id, source_id, operation, state, payload_hash)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (org_id, id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.orgId, id, input.issueLoopId, input.sourceId, input.operation, payloadHash],
    );
    if (inserted.rows[0] !== undefined) return { row: mapRow(inserted.rows[0]), inserted: true };
    const existing = await client.query<SourceSyncRow>(
      `SELECT ${COLUMNS} FROM source_sync_outbox WHERE org_id = $1 AND id = $2`,
      [input.orgId, id],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error("source sync outbox row disappeared after idempotent conflict");
    return { row: mapRow(row), inserted: false };
  },

  async listRunnable(client: QueryClient, limit: number): Promise<SourceSyncOutboxRow[]> {
    const result = await client.query<SourceSyncRow>(
      `SELECT ${COLUMNS} FROM source_sync_outbox
        WHERE state IN ('pending','sent')
          AND (claim_owner IS NULL OR claim_expires_at <= now())
        ORDER BY created_at ASC, id ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => mapRow(row));
  },

  async listDistinctRunnableOrgIds(client: QueryClient): Promise<string[]> {
    const result = await client.query<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM source_sync_outbox WHERE state IN ('pending','sent')",
    );
    return result.rows.map((row) => row.org_id);
  },

  async claim(client: QueryClient, input: SourceSyncClaimInput): Promise<SourceSyncOutboxRow | undefined> {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0)
      throw new RangeError("source sync lease must be positive");
    const result = await client.query<SourceSyncRow>(
      `UPDATE source_sync_outbox
          SET claim_owner = $2,
              claim_expires_at = now() + ($3::bigint * interval '1 millisecond')
        WHERE id = $1 AND state IN ('pending','sent')
          AND (claim_owner IS NULL OR claim_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [input.id, input.workerId, input.leaseMs],
    );
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
  },

  async markSent(client: QueryClient, id: string, workerId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox SET state = 'sent'
        WHERE id = $1 AND state = 'pending' AND claim_owner = $2`,
      [id, workerId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async markVerified(client: QueryClient, id: string, workerId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET state = 'verified', claim_owner = NULL, claim_expires_at = NULL
        WHERE id = $1 AND state IN ('pending','sent') AND claim_owner = $2`,
      [id, workerId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async release(client: QueryClient, id: string, workerId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox SET claim_owner = NULL, claim_expires_at = NULL
        WHERE id = $1 AND state IN ('pending','sent') AND claim_owner = $2`,
      [id, workerId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async markExternallyClosed(client: QueryClient, id: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET state = 'externally_closed_unverified', claim_owner = NULL, claim_expires_at = NULL
        WHERE id = $1 AND state IN ('pending','sent')`,
      [id],
    );
    return (result.rowCount ?? 0) === 1;
  },
} as const;
