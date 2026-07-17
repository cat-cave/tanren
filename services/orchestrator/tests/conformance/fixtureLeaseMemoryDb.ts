import type { FixtureLeaseRecord, MemoryDb, QueryResult } from "./conformanceMemoryDb.js";

function copy(row: FixtureLeaseRecord): FixtureLeaseRecord {
  return { ...row };
}

/**
 * Lane-owned SQL body for the frozen `fixture_leases` conformance-memory stub.
 * The scoped client models the table's RLS policy: only its current org can
 * read or mutate a row, even if a query carries another org's identifier.
 */
export class FixtureLeaseScopedClient {
  public constructor(
    private readonly db: MemoryDb,
    private readonly orgId: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  public async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const result = this.fixtureLeaseSql(sql, params);
    if (result === undefined) throw new Error(`FixtureLeaseMemoryDb: unrecognized SQL: ${sql}`);
    return result;
  }

  private fixtureLeaseSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (sql.startsWith("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")) {
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes("FROM fixture_leases") &&
      sql.includes("correlation_namespace = $3") &&
      sql.includes("state = 'leased'")
    ) {
      const [orgId, projectId, namespace] = params as [string, string, string];
      const row = this.visible().find(
        (lease) =>
          lease.org_id === orgId &&
          lease.project_id === projectId &&
          lease.correlation_namespace === namespace &&
          lease.state === "leased",
      );
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [copy(row)], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO fixture_leases")) {
      const [orgId, projectId, leaseId, kind, resourceRef, namespace, expiresAt] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        Date | null,
      ];
      if (orgId !== this.orgId) return { rows: [], rowCount: 0 };
      const row: FixtureLeaseRecord = {
        org_id: orgId,
        project_id: projectId,
        lease_id: leaseId,
        kind,
        resource_ref: resourceRef,
        correlation_namespace: namespace,
        state: "leased",
        acquired_at: new Date(),
        expires_at: expiresAt,
        cleanup_evidence_hash: null,
      };
      this.db.fixtureLeases.push(row);
      return { rows: [copy(row)], rowCount: 1 };
    }
    if (sql.includes("UPDATE fixture_leases") && sql.includes("SET state = 'released'")) {
      const [orgId, projectId, leaseId, cleanupEvidenceHash] = params as [string, string, string, string | null];
      const row = this.visible().find(
        (lease) =>
          lease.org_id === orgId &&
          lease.project_id === projectId &&
          lease.lease_id === leaseId &&
          lease.state === "leased",
      );
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.state = "released";
      row.cleanup_evidence_hash = cleanupEvidenceHash;
      return { rows: [copy(row)], rowCount: 1 };
    }
    if (sql.includes("UPDATE fixture_leases") && sql.includes("SET state = 'expired'")) {
      const [orgId, projectId, observedAt] = params as [string, string, Date];
      const rows = this.visible().filter(
        (lease) =>
          lease.org_id === orgId &&
          lease.project_id === projectId &&
          lease.state === "leased" &&
          lease.expires_at !== null &&
          lease.expires_at <= observedAt,
      );
      rows.forEach((row) => {
        row.state = "expired";
      });
      return { rows: rows.map((row) => copy(row)), rowCount: rows.length };
    }
    if (sql.includes("FROM fixture_leases") && sql.includes("lease_id = $3")) {
      const [orgId, projectId, leaseId] = params as [string, string, string];
      const row = this.visible().find(
        (lease) => lease.org_id === orgId && lease.project_id === projectId && lease.lease_id === leaseId,
      );
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [copy(row)], rowCount: 1 };
    }
    if (sql.includes("FROM fixture_leases") && sql.includes("project_id = $2")) {
      const [orgId, projectId] = params as [string, string];
      const rows = this.visible()
        .filter((lease) => lease.org_id === orgId && lease.project_id === projectId)
        .sort(
          (left, right) =>
            left.acquired_at.getTime() - right.acquired_at.getTime() || left.lease_id.localeCompare(right.lease_id),
        )
        .map((row) => copy(row));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }

  private visible(): FixtureLeaseRecord[] {
    return this.db.fixtureLeases.filter((lease) => lease.org_id === this.orgId);
  }
}
