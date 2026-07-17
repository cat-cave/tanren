import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  type FixtureLease,
  type FixtureLeaseKind,
  type ObserveFixtureLeaseExpiryInput,
  type ReleaseFixtureLeaseInput,
} from "../contracts/fixtureLeaseAdapter.js";
import { oneOf } from "../data/pgRows.js";

type QueryClient = Pick<pg.PoolClient, "query">;

const FIXTURE_LEASE_KINDS = ["org", "account", "channel", "dataset"] as const;
const FIXTURE_LEASE_STATES = ["leased", "released", "expired"] as const;
const LEASE_COLUMNS = `org_id, project_id, lease_id, kind, resource_ref, correlation_namespace,
  state, acquired_at, expires_at, cleanup_evidence_hash`;

interface RawFixtureLeaseRow {
  org_id: string;
  project_id: string;
  lease_id: string;
  kind: string;
  resource_ref: string;
  correlation_namespace: string;
  state: string;
  acquired_at: Date;
  expires_at: Date | null;
  cleanup_evidence_hash: string | null;
}

export interface CreateFixtureLeaseInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly leaseId: string;
  readonly kind: FixtureLeaseKind;
  readonly resourceRef: string;
  readonly correlationNamespace: string;
  readonly expiresAt?: Date;
}

export interface AcquireFixtureLeaseResult {
  readonly lease: FixtureLease;
  /** True only when this call inserted a new leased row. */
  readonly created: boolean;
}

function decode(row: RawFixtureLeaseRow): FixtureLease {
  const kind = oneOf(row.kind, FIXTURE_LEASE_KINDS, "fixture_leases.kind");
  const state = oneOf(row.state, FIXTURE_LEASE_STATES, "fixture_leases.state");
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    leaseId: row.lease_id,
    kind,
    resourceRef: row.resource_ref,
    correlationNamespace: row.correlation_namespace,
    state,
    acquiredAt: row.acquired_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.cleanup_evidence_hash === null ? {} : { cleanupEvidenceHash: row.cleanup_evidence_hash }),
  };
}

/** Org-scoped persistence for stateful runtime fixture leases. */
export class PgFixtureLeaseRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async acquire(input: CreateFixtureLeaseInput): Promise<AcquireFixtureLeaseResult> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.acquireOnClient(client, input));
  }

  /** Acquire on an existing org-scoped transaction so the caller can append its event atomically. */
  public async acquireOnClient(
    client: QueryClient,
    input: CreateFixtureLeaseInput,
  ): Promise<AcquireFixtureLeaseResult> {
    // The barrier does not carry a uniqueness constraint for this semantic key.
    // Serialize its miss path so parallel callers cannot create duplicate live
    // leases for a single execution correlation namespace.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.orgId}:${input.projectId}:${input.correlationNamespace}`,
    ]);
    const existing = await client.query<RawFixtureLeaseRow>(
      `SELECT ${LEASE_COLUMNS}
         FROM fixture_leases
        WHERE org_id = $1 AND project_id = $2 AND correlation_namespace = $3 AND state = 'leased'
        ORDER BY acquired_at DESC, lease_id DESC
        LIMIT 1`,
      [input.orgId, input.projectId, input.correlationNamespace],
    );
    const active = existing.rows[0];
    if (active !== undefined) return { lease: decode(active), created: false };

    const inserted = await client.query<RawFixtureLeaseRow>(
      `INSERT INTO fixture_leases
         (org_id, project_id, lease_id, kind, resource_ref, correlation_namespace, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'leased', $7)
       RETURNING ${LEASE_COLUMNS}`,
      [
        input.orgId,
        input.projectId,
        input.leaseId,
        input.kind,
        input.resourceRef,
        input.correlationNamespace,
        input.expiresAt ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("fixture lease insert returned no row");
    return { lease: decode(row), created: true };
  }

  public async release(
    input: ReleaseFixtureLeaseInput,
  ): Promise<{ readonly lease?: FixtureLease; readonly changed: boolean }> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.releaseOnClient(client, input));
  }

  /** Release only a currently leased row; a repeat returns the prior release without mutating evidence. */
  public async releaseOnClient(
    client: QueryClient,
    input: ReleaseFixtureLeaseInput,
  ): Promise<{ readonly lease?: FixtureLease; readonly changed: boolean }> {
    const updated = await client.query<RawFixtureLeaseRow>(
      `UPDATE fixture_leases
          SET state = 'released', cleanup_evidence_hash = $4
        WHERE org_id = $1 AND project_id = $2 AND lease_id = $3 AND state = 'leased'
        RETURNING ${LEASE_COLUMNS}`,
      [input.orgId, input.projectId, input.leaseId, input.cleanupEvidenceHash ?? null],
    );
    const released = updated.rows[0];
    if (released !== undefined) return { lease: decode(released), changed: true };

    const current = await client.query<RawFixtureLeaseRow>(
      `SELECT ${LEASE_COLUMNS}
         FROM fixture_leases
        WHERE org_id = $1 AND project_id = $2 AND lease_id = $3
        LIMIT 1`,
      [input.orgId, input.projectId, input.leaseId],
    );
    const row = current.rows[0];
    return row === undefined ? { changed: false } : { lease: decode(row), changed: false };
  }

  public async observeExpiry(input: ObserveFixtureLeaseExpiryInput): Promise<FixtureLease[]> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.observeExpiryOnClient(client, input));
  }

  /** Transition only the rows that are still live when this observation occurs. */
  public async observeExpiryOnClient(
    client: QueryClient,
    input: ObserveFixtureLeaseExpiryInput,
  ): Promise<FixtureLease[]> {
    const expired = await client.query<RawFixtureLeaseRow>(
      `UPDATE fixture_leases
          SET state = 'expired'
        WHERE org_id = $1
          AND project_id = $2
          AND state = 'leased'
          AND expires_at IS NOT NULL
          AND expires_at <= $3
        RETURNING ${LEASE_COLUMNS}`,
      [input.orgId, input.projectId, input.observedAt ?? new Date()],
    );
    return expired.rows.map(decode);
  }

  public async list(orgId: string, projectId: string): Promise<FixtureLease[]> {
    return runWithOrgScope(this.pool, orgId, (client) => this.listOnClient(client, orgId, projectId));
  }

  public async listOnClient(client: QueryClient, orgId: string, projectId: string): Promise<FixtureLease[]> {
    const result = await client.query<RawFixtureLeaseRow>(
      `SELECT ${LEASE_COLUMNS}
         FROM fixture_leases
        WHERE org_id = $1 AND project_id = $2
        ORDER BY acquired_at ASC, lease_id ASC`,
      [orgId, projectId],
    );
    return result.rows.map(decode);
  }
}

export { FIXTURE_LEASE_KINDS, FIXTURE_LEASE_STATES };
