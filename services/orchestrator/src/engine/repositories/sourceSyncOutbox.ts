// cspell:ignore ssync

import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const SOURCE_SYNC_OPERATIONS = ["close", "reopen", "comment"] as const;
export type SourceSyncOperation = (typeof SOURCE_SYNC_OPERATIONS)[number];
export const SOURCE_SYNC_STATES = ["pending", "sent", "verified", "externally_closed_unverified"] as const;
export type SourceSyncState = (typeof SOURCE_SYNC_STATES)[number];

export interface SourceSyncOutboxRow {
  orgId: string;
  id: string;
  issueLoopId: string;
  sourceId: string;
  operation: SourceSyncOperation;
  state: SourceSyncState;
  payload: Record<string, unknown>;
  payloadHash: string;
  resolutionDecisionId: string | null;
  attempt: number;
  nextAttemptAt: Date;
  providerReceipt: Record<string, unknown> | null;
  readback: Record<string, unknown> | null;
  lastError: string | null;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueSourceSyncInput {
  orgId: string;
  issueLoopId: string;
  sourceId: string;
  operation: SourceSyncOperation;
  payload: Record<string, unknown>;
  /** Required for every close and checked against the immutable authority ledger. */
  resolutionDecisionId?: string;
}

export interface SourceSyncClaimInput {
  orgId: string;
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
  payload: unknown;
  payload_hash: string;
  resolution_decision_id: string | null;
  attempt: number | string;
  next_attempt_at: Date | string;
  provider_receipt: unknown;
  readback: unknown;
  last_error: string | null;
  claim_owner: string | null;
  claim_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const Operation = z.enum(SOURCE_SYNC_OPERATIONS);
const State = z.enum(SOURCE_SYNC_STATES);
const JsonRecord = z.record(z.string(), z.unknown());
const COLUMNS = `org_id, id, issue_loop_id, source_id, operation, state, payload, payload_hash,
 resolution_decision_id, attempt, next_attempt_at, provider_receipt, readback, last_error,
 claim_owner, claim_expires_at, created_at, updated_at`;
const OUTBOX_COLUMNS = `outbox.org_id, outbox.id, outbox.issue_loop_id, outbox.source_id, outbox.operation,
 outbox.state, outbox.payload, outbox.payload_hash, outbox.resolution_decision_id, outbox.attempt,
 outbox.next_attempt_at, outbox.provider_receipt, outbox.readback, outbox.last_error, outbox.claim_owner,
 outbox.claim_expires_at, outbox.created_at, outbox.updated_at`;

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value);
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return value === null ? null : JsonRecord.parse(value);
}

function mapRow(row: SourceSyncRow): SourceSyncOutboxRow {
  return {
    orgId: row.org_id,
    id: row.id,
    issueLoopId: row.issue_loop_id,
    sourceId: row.source_id,
    operation: Operation.parse(row.operation),
    state: State.parse(row.state),
    payload: JsonRecord.parse(row.payload),
    payloadHash: row.payload_hash,
    resolutionDecisionId: row.resolution_decision_id,
    attempt: Number(row.attempt),
    nextAttemptAt: date(row.next_attempt_at),
    providerReceipt: nullableRecord(row.provider_receipt),
    readback: nullableRecord(row.readback),
    lastError: row.last_error,
    claimOwner: row.claim_owner,
    claimExpiresAt: nullableDate(row.claim_expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
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
    .update(
      canonical({
        issueLoopId: input.issueLoopId,
        operation: input.operation,
        payload: input.payload,
        resolutionDecisionId: input.resolutionDecisionId ?? null,
      }),
    )
    .digest("hex")}`;
}

function deterministicId(input: EnqueueSourceSyncInput, payloadHash: string): string {
  return `ssync_${createHash("sha256")
    .update(`${input.orgId}:${input.issueLoopId}:${input.sourceId}:${input.operation}:${payloadHash}`)
    .digest("hex")}`;
}

async function assertCloseAuthority(client: QueryClient, input: EnqueueSourceSyncInput): Promise<void> {
  if (input.operation !== "close") return;
  if (input.resolutionDecisionId === undefined)
    throw new Error("source close requires a ResolutionAuthority decision id");
  const result = await client.query(
    `SELECT 1
       FROM resolution_decisions AS decision
       JOIN issue_loops AS loop
         ON loop.org_id = decision.org_id AND loop.id = decision.issue_loop_id
      WHERE decision.org_id = $1
        AND decision.id = $2
        AND decision.issue_loop_id = $3
        AND decision.decision IN ('authorized', 'waived')
        AND loop.source_id = $4`,
    [input.orgId, input.resolutionDecisionId, input.issueLoopId, input.sourceId],
  );
  if (result.rowCount !== 1) throw new Error("source close lacks an authorized ResolutionAuthority decision");
}

function positiveLease(input: Pick<SourceSyncClaimInput, "leaseMs">): void {
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) throw new RangeError("source sync lease must be positive");
}

export const SourceSyncOutboxStore = {
  async enqueue(client: QueryClient, input: EnqueueSourceSyncInput): Promise<SourceSyncOutboxRow> {
    return (await SourceSyncOutboxStore.enqueueWithOutcome(client, input)).row;
  },

  async enqueueWithOutcome(client: QueryClient, input: EnqueueSourceSyncInput): Promise<EnqueueSourceSyncResult> {
    await assertCloseAuthority(client, input);
    const payloadHash = sourceSyncPayloadHash(input);
    const id = deterministicId(input, payloadHash);
    const inserted = await client.query<SourceSyncRow>(
      `INSERT INTO source_sync_outbox
         (org_id, id, issue_loop_id, source_id, operation, state, payload, payload_hash, resolution_decision_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7, $8)
       ON CONFLICT (org_id, id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.orgId,
        id,
        input.issueLoopId,
        input.sourceId,
        input.operation,
        JSON.stringify(input.payload),
        payloadHash,
        input.resolutionDecisionId ?? null,
      ],
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
        WHERE state IN ('pending','sent') AND next_attempt_at <= now()
          AND (claim_owner IS NULL OR claim_expires_at <= now())
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  },

  async listDistinctRunnableOrgIds(client: QueryClient): Promise<string[]> {
    const result = await client.query<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM source_sync_outbox WHERE state IN ('pending','sent') AND next_attempt_at <= now()",
    );
    return result.rows.map((row) => row.org_id);
  },

  async claim(client: QueryClient, input: SourceSyncClaimInput): Promise<SourceSyncOutboxRow | undefined> {
    positiveLease(input);
    const result = await client.query<SourceSyncRow>(
      `UPDATE source_sync_outbox
          SET claim_owner = $3, claim_expires_at = now() + ($4::bigint * interval '1 millisecond'), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent') AND next_attempt_at <= now()
          AND (claim_owner IS NULL OR claim_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [input.orgId, input.id, input.workerId, input.leaseMs],
    );
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
  },

  async claimNext(
    client: QueryClient,
    input: Omit<SourceSyncClaimInput, "id">,
  ): Promise<SourceSyncOutboxRow | undefined> {
    positiveLease(input);
    const result = await client.query<SourceSyncRow>(
      `WITH candidate AS (
         SELECT id FROM source_sync_outbox
          WHERE org_id = $1 AND state IN ('pending','sent') AND next_attempt_at <= now()
            AND (claim_owner IS NULL OR claim_expires_at <= now())
          ORDER BY next_attempt_at ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE source_sync_outbox AS outbox
          SET claim_owner = $2, claim_expires_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
         FROM candidate
        WHERE outbox.org_id = $1 AND outbox.id = candidate.id
       RETURNING ${OUTBOX_COLUMNS}`,
      [input.orgId, input.workerId, input.leaseMs],
    );
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
  },

  async beginAttempt(client: QueryClient, input: Pick<SourceSyncClaimInput, "orgId" | "id" | "workerId">) {
    const result = await client.query<SourceSyncRow>(
      `UPDATE source_sync_outbox
          SET state = 'sent', attempt = attempt + 1, last_error = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent') AND claim_owner = $3
          AND claim_expires_at > now()
       RETURNING ${COLUMNS}`,
      [input.orgId, input.id, input.workerId],
    );
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
  },

  async renewClaim(client: QueryClient, input: SourceSyncClaimInput): Promise<boolean> {
    positiveLease(input);
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET claim_expires_at = now() + ($4::bigint * interval '1 millisecond'), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent') AND claim_owner = $3
          AND claim_expires_at > now()`,
      [input.orgId, input.id, input.workerId, input.leaseMs],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async recordProviderReceipt(
    client: QueryClient,
    input: Pick<SourceSyncClaimInput, "orgId" | "id" | "workerId"> & { receipt: Record<string, unknown> },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET provider_receipt = $4::jsonb, last_error = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state = 'sent' AND claim_owner = $3
          AND claim_expires_at > now()`,
      [input.orgId, input.id, input.workerId, JSON.stringify(input.receipt)],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async markVerified(
    client: QueryClient,
    input: Pick<SourceSyncClaimInput, "orgId" | "id" | "workerId"> & {
      readback: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET state = 'verified', readback = $4::jsonb, claim_owner = NULL, claim_expires_at = NULL,
              next_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state = 'sent' AND claim_owner = $3 AND provider_receipt IS NOT NULL
          AND provider_receipt->>'reconciled' IS DISTINCT FROM 'true'
          AND claim_expires_at > now()`,
      [input.orgId, input.id, input.workerId, JSON.stringify(input.readback)],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async releaseFailure(
    client: QueryClient,
    input: Pick<SourceSyncClaimInput, "orgId" | "id" | "workerId"> & { error: string; retryMs: number },
  ): Promise<boolean> {
    const retryMs = Math.max(0, Math.floor(input.retryMs));
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET claim_owner = NULL, claim_expires_at = NULL, last_error = $4,
              next_attempt_at = now() + ($5::bigint * interval '1 millisecond'), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent') AND claim_owner = $3`,
      [input.orgId, input.id, input.workerId, input.error.slice(0, 1_000), retryMs],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async release(client: QueryClient, input: Pick<SourceSyncClaimInput, "orgId" | "id" | "workerId">): Promise<boolean> {
    const result = await client.query(
      `UPDATE source_sync_outbox
          SET claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent') AND claim_owner = $3`,
      [input.orgId, input.id, input.workerId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async redrive(client: QueryClient, orgId: string, id: string): Promise<SourceSyncOutboxRow | undefined> {
    const result = await client.query<SourceSyncRow>(
      `UPDATE source_sync_outbox
          SET claim_owner = NULL, claim_expires_at = NULL, next_attempt_at = now(), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND state IN ('pending','sent')
          AND (claim_owner IS NULL OR claim_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [orgId, id],
    );
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
  },

  async supersedeCloseSyncsForExternalClose(
    client: QueryClient,
    orgId: string,
    issueLoopId: string,
  ): Promise<SourceSyncOutboxRow[]> {
    const result = await client.query<SourceSyncRow>(
      `UPDATE source_sync_outbox
          SET state = 'externally_closed_unverified', claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE org_id = $1 AND issue_loop_id = $2 AND operation = 'close' AND state IN ('pending','sent')
       RETURNING ${COLUMNS}`,
      [orgId, issueLoopId],
    );
    return result.rows.map(mapRow);
  },
} as const;
