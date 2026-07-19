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
import { z } from "zod";
import { DesignReleaseState, type DesignSystemReleaseV1, parseDesignSystemRelease } from "./designArtifactSchemas.js";
import { parseWebDesignWriterContext, type WebDesignWriterContext } from "./webWriterContext.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The `design_systems.lifecycle` domain (mirrors the `design_systems_lifecycle_check`
 * DB constraint). Decoded through this zod boundary — an unknown value fails LOUD
 * rather than being cast (the no-`as Enum` posture the sibling stores hold). */
const DesignSystemLifecycle = z.enum(["draft", "active", "archived"]);

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

/** Input to publish a draft/validated release: bind its canonical artifact + stamp
 * publication provenance (the `_published_check` invariant). */
export interface PublishDesignReleaseInput {
  readonly orgId: string;
  readonly releaseId: string;
  readonly canonicalArtifactId: string;
  readonly publishedBy: string;
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

/** The head contract currently resolves to more than one web system. */
export class AmbiguousProjectWebDesignSystemError extends Error {
  constructor(
    readonly orgId: string,
    readonly projectId: string,
    readonly designSystemIds: readonly string[],
  ) {
    super(
      `project '${projectId}' in org '${orgId}' resolves to multiple published web design systems: ${designSystemIds.join(", ")}`,
    );
    this.name = "AmbiguousProjectWebDesignSystemError";
  }
}

/** A release points at an artifact whose persisted Writer projection is malformed. */
export class PersistedWebDesignWriterContextError extends Error {
  constructor(
    readonly orgId: string,
    readonly projectId: string,
    readonly artifactId: string,
    readonly detail: string,
  ) {
    super(
      `web design Writer context for project '${projectId}' in org '${orgId}' artifact '${artifactId}' is invalid: ${detail}`,
    );
    this.name = "PersistedWebDesignWriterContextError";
  }
}

interface ProjectWebDesignSystemRow {
  readonly design_system_id: string;
  readonly release_id: string;
  readonly artifact_id: string;
  readonly web_writer_context: unknown;
}

/**
 * Resolve the one published web system built from the project's current design
 * contract. ds-5 will replace this lineage lookup with an explicit project
 * binding; until then, ambiguity is a loud fault rather than an arbitrary
 * org-wide default. The caller owns the RLS-scoped client so this composes into
 * the run hydration transaction without opening a nested connection.
 */
export async function resolveProjectWebDesignSystem(
  client: QueryClient,
  input: { orgId: string; projectId: string },
): Promise<WebDesignWriterContext | undefined> {
  const result = await client.query<ProjectWebDesignSystemRow>(
    `WITH head_contract AS (
       SELECT id, org_id, version
         FROM design_contracts
        WHERE org_id = $1 AND project_id = $2
        ORDER BY version DESC
        LIMIT 1
     )
     SELECT DISTINCT ON (release.design_system_id)
       release.design_system_id,
       release.id AS release_id,
       artifact.id AS artifact_id,
       artifact.web_writer_context
       FROM head_contract contract
       JOIN design_system_releases release
         ON release.org_id = contract.org_id
        AND release.contract_id = contract.id
        AND release.contract_version = contract.version
        AND release.state = 'published'
       JOIN design_artifacts artifact
         ON artifact.org_id = release.org_id
        AND artifact.id = release.canonical_artifact_id
      ORDER BY release.design_system_id, release.version DESC`,
    [input.orgId, input.projectId],
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length > 1) {
    throw new AmbiguousProjectWebDesignSystemError(
      input.orgId,
      input.projectId,
      result.rows.map((row) => row.design_system_id),
    );
  }
  const row = result.rows[0]!;
  let context: WebDesignWriterContext;
  try {
    context = parseWebDesignWriterContext(row.web_writer_context);
  } catch (error: unknown) {
    throw new PersistedWebDesignWriterContextError(
      input.orgId,
      input.projectId,
      row.artifact_id,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    context.designSystemId !== row.design_system_id ||
    context.releaseId !== row.release_id ||
    context.artifactId !== row.artifact_id
  ) {
    throw new PersistedWebDesignWriterContextError(
      input.orgId,
      input.projectId,
      row.artifact_id,
      "persisted identifiers do not match the published release/artifact linkage",
    );
  }
  return context;
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
        lifecycle: DesignSystemLifecycle.parse(row.lifecycle),
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

  /**
   * PUBLISH a draft/validated release: transition it to `published`, binding the
   * canonical artifact it resolves to and stamping `published_at`/`published_by`.
   * This satisfies the `design_system_releases_published_check` invariant (a
   * published release MUST carry all three). Only a non-published release is a
   * legal source (the `state IN ('draft','validated')` guard), so a second publish
   * of the same release is a no-op that surfaces as `DesignSystemNotFoundError`
   * rather than silently re-stamping an immutable published row — the caller owns
   * idempotency (compose short-circuits on an already-published lineage). Org-scoped
   * under RLS, exactly like every other write on this store.
   */
  async publishRelease(input: PublishDesignReleaseInput): Promise<DesignSystemReleaseV1> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const rows = await client.query<DesignReleaseDbRow>(
        `UPDATE design_system_releases
            SET state = 'published',
                canonical_artifact_id = $1,
                published_at = now(),
                published_by = $2
          WHERE org_id = $3 AND id = $4 AND state IN ('draft', 'validated')
        RETURNING ${RELEASE_COLUMNS}`,
        [input.canonicalArtifactId, input.publishedBy, input.orgId, input.releaseId],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw new DesignSystemNotFoundError(input.orgId, "publishable release", input.releaseId);
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
