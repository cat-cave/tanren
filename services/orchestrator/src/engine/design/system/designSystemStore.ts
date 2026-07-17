// ds-0 — the design-system PERSISTENCE seam (`DesignSystemReleaseStore`).
//
// The org-scoped store over the `design_systems` + `design_system_releases`
// backbone (schemaDesignSystems.ts). Every operation runs inside
// `runWithOrgScope` so the deny-by-default RLS policy (+ FORCE) applies: a write
// stamps the caller's org, and a read under org B (or with no org GUC) sees ZERO
// of org A's rows — the tenancy proof ds-0 must demonstrate.
//
// FOUNDATION SCOPE: create-system, create-release (immutable, monotonic version),
// and the read paths downstream nodes build against. Publication CAS, channel
// promotion, curation, validation, and binding are ds-5's engine logic on top of
// this seam — deliberately not here. Reads re-derive nothing they cannot verify;
// a corrupt/parse-failing release row surfaces as a typed error, never a silent
// default (mirrors the design_contracts store posture).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { DesignReleaseState, type DesignSystemReleaseV1, parseDesignSystemRelease } from "./designArtifactSchemas.js";

/** A design-system family row as stored. */
export interface DesignSystemRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly lifecycle: "draft" | "active" | "archived";
  readonly defaultChannel: string;
}

/** Input to create a design-system family (org stamped by the scope). */
export interface CreateDesignSystemInput {
  readonly orgId: string;
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultChannel?: string;
}

/** Input to create an immutable release. `version` is caller-assigned (monotonic per system). */
export interface CreateDesignReleaseInput {
  readonly orgId: string;
  readonly id: string;
  readonly designSystemId: string;
  readonly version: number;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly contractDigest: string;
  readonly manifestSchemaVersion: number;
  readonly createdBy: string;
  readonly parentReleaseId?: string | null;
}

/** Raised when a requested design system / release is absent under the org scope. */
export class DesignSystemNotFoundError extends Error {
  constructor(
    readonly orgId: string,
    readonly entity: string,
    readonly id: string,
  ) {
    super(`design ${entity} '${id}' not found for org '${orgId}'`);
    this.name = "DesignSystemNotFoundError";
  }
}

/**
 * The design-system release store. Constructed with a `pg.Pool`; every method
 * opens its own short `runWithOrgScope` transaction (a connection is held only for
 * the DB op, never across external I/O — the worker-safe posture).
 */
export class DesignSystemReleaseStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Create a design-system family. Idempotent-safe on the (org_id, id) PK conflict. */
  async createSystem(input: CreateDesignSystemInput): Promise<DesignSystemRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const rows = await client.query<{
        id: string;
        slug: string;
        name: string;
        description: string;
        lifecycle: string;
        default_channel: string;
      }>(
        `INSERT INTO design_systems (org_id, id, slug, name, description, default_channel)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug, name, description, lifecycle, default_channel`,
        [input.orgId, input.id, input.slug, input.name, input.description ?? "", input.defaultChannel ?? "stable"],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw new DesignSystemNotFoundError(input.orgId, "system", input.id);
      }
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        lifecycle: row.lifecycle as DesignSystemRow["lifecycle"],
        defaultChannel: row.default_channel,
      };
    });
  }

  /** Create an immutable draft release. State is `draft` (publication is ds-5). */
  async createRelease(input: CreateDesignReleaseInput): Promise<DesignSystemReleaseV1> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const rows = await client.query<DesignReleaseDbRow>(
        `INSERT INTO design_system_releases
           (org_id, id, design_system_id, version, parent_release_id, state,
            contract_id, contract_version, contract_digest, manifest_schema_version,
            canonical_artifact_id, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, NULL, $10)
         RETURNING ${RELEASE_COLUMNS}`,
        [
          input.orgId,
          input.id,
          input.designSystemId,
          input.version,
          input.parentReleaseId ?? null,
          input.contractId,
          input.contractVersion,
          input.contractDigest,
          input.manifestSchemaVersion,
          input.createdBy,
        ],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw new DesignSystemNotFoundError(input.orgId, "release", input.id);
      }
      return rowToRelease(row);
    });
  }

  /** Read one release by id under the org scope. Throws if absent (deny-by-default). */
  async getRelease(orgId: string, releaseId: string): Promise<DesignSystemReleaseV1> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<DesignReleaseDbRow>(
        `SELECT ${RELEASE_COLUMNS} FROM design_system_releases WHERE org_id = $1 AND id = $2`,
        [orgId, releaseId],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw new DesignSystemNotFoundError(orgId, "release", releaseId);
      }
      return rowToRelease(row);
    });
  }

  /** Read the highest-version release for a design system, or null if none. */
  async getLatestRelease(orgId: string, designSystemId: string): Promise<DesignSystemReleaseV1 | null> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<DesignReleaseDbRow>(
        `SELECT ${RELEASE_COLUMNS} FROM design_system_releases
         WHERE org_id = $1 AND design_system_id = $2
         ORDER BY version DESC LIMIT 1`,
        [orgId, designSystemId],
      );
      const row = rows.rows[0];
      return row === undefined ? null : rowToRelease(row);
    });
  }

  /** List a design system's releases (newest version first) under the org scope. */
  async listReleases(orgId: string, designSystemId: string): Promise<DesignSystemReleaseV1[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<DesignReleaseDbRow>(
        `SELECT ${RELEASE_COLUMNS} FROM design_system_releases
         WHERE org_id = $1 AND design_system_id = $2 ORDER BY version DESC`,
        [orgId, designSystemId],
      );
      return rows.rows.map(rowToRelease);
    });
  }
}

const RELEASE_COLUMNS =
  "id, design_system_id, version, parent_release_id, state, contract_id, " +
  "contract_version, contract_digest, manifest_schema_version, canonical_artifact_id, compatibility_summary";

interface DesignReleaseDbRow {
  id: string;
  design_system_id: string;
  version: number;
  parent_release_id: string | null;
  state: string;
  contract_id: string;
  contract_version: number;
  contract_digest: string;
  manifest_schema_version: number;
  canonical_artifact_id: string | null;
  compatibility_summary: Record<string, unknown>;
}

/** Map a DB row to the typed release, re-validating through the schema (fail-closed). */
function rowToRelease(row: DesignReleaseDbRow): DesignSystemReleaseV1 {
  return parseDesignSystemRelease({
    releaseId: row.id,
    designSystemId: row.design_system_id,
    version: row.version,
    parentReleaseId: row.parent_release_id,
    state: DesignReleaseState.parse(row.state),
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    contractDigest: row.contract_digest,
    manifestSchemaVersion: row.manifest_schema_version,
    canonicalArtifactId: row.canonical_artifact_id,
    compatibilitySummary: row.compatibility_summary,
  });
}
