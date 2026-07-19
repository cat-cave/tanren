// ds-5 — the WITHIN-ORG DESIGN REUSE read/bind seam (Studio, bindings, exports).
//
// The org-scoped store the ds-5 HTTP surface reads/writes against: the reusable
// design-system CATALOG (families + their published releases + channels +
// how many projects reuse each), the per-project REUSE BINDING (read + upsert),
// and the artifact EXPORT file index (for the real downloadable projections).
// Every op runs inside `runWithOrgScope` so the deny-by-default RLS policy (+
// FORCE) applies: a project can only ever bind to / read a design system OWNED
// BY ITS OWN ORG. A dangling / non-published bind TARGET fails LOUD
// (`DesignBindingTargetError`) — a reuse can only point at a PUBLISHED release,
// never a fabricated or cross-org one.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";

/** The pin discriminant on `project_design_bindings.pin_mode`. */
export const DesignBindingPinMode = z.enum(["release", "channel"]);
export type DesignBindingPinMode = z.infer<typeof DesignBindingPinMode>;

/** A published release summary shown in the reuse catalog. */
export interface CatalogReleaseSummary {
  readonly releaseId: string;
  readonly version: number;
  readonly contractDigest: string;
  readonly canonicalArtifactId: string;
  readonly publishedAt: string;
}

/** One reusable design-system family + how it is currently reused across the org. */
export interface DesignSystemCatalogEntry {
  readonly designSystemId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly lifecycle: string;
  readonly defaultChannel: string;
  readonly publishedReleaseCount: number;
  readonly latestPublishedRelease: CatalogReleaseSummary | null;
  readonly channels: readonly { readonly channel: string; readonly releaseId: string }[];
  /** Number of projects in the org currently bound to (reusing) this family. */
  readonly reuseCount: number;
}

/** A project's current within-org reuse binding. */
export interface ProjectDesignBinding {
  readonly projectId: string;
  readonly designSystemId: string;
  readonly pinMode: DesignBindingPinMode;
  readonly pinnedReleaseId: string | null;
  readonly channel: string | null;
  readonly boundBy: string;
  readonly updatedAt: string;
}

export interface PutDesignBindingInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly designSystemId: string;
  readonly pinMode: DesignBindingPinMode;
  readonly pinnedReleaseId?: string | null;
  readonly channel?: string | null;
  readonly boundBy: string;
}

/** A file inside a persisted artifact bundle (the export projection metadata). */
export interface DesignArtifactExportFile {
  readonly path: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly digest: string;
  readonly byteSize: number;
}

/** Raised when a bind target does not resolve to a PUBLISHED same-org release. */
export class DesignBindingTargetError extends Error {
  constructor(
    readonly orgId: string,
    readonly detail: string,
  ) {
    super(`design binding target invalid for org '${orgId}': ${detail}`);
    this.name = "DesignBindingTargetError";
  }
}

function toIso(value: Date | string | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

interface BindingDbRow {
  project_id: string;
  design_system_id: string;
  pin_mode: string;
  pinned_release_id: string | null;
  channel: string | null;
  bound_by: string;
  updated_at: Date;
}

function mapBindingRow(row: BindingDbRow): ProjectDesignBinding {
  return {
    projectId: row.project_id,
    designSystemId: row.design_system_id,
    pinMode: DesignBindingPinMode.parse(row.pin_mode),
    pinnedReleaseId: row.pinned_release_id,
    channel: row.channel,
    boundBy: row.bound_by,
    updatedAt: toIso(row.updated_at),
  };
}

const BINDING_COLUMNS = "project_id, design_system_id, pin_mode, pinned_release_id, channel, bound_by, updated_at";

/** The ds-5 Studio store: reusable-systems catalog + reuse bindings + export index. */
export class DesignStudioStore {
  constructor(private readonly pool: pg.Pool) {}

  /** The org's reusable design-system catalog (newest-updated first). */
  async listCatalog(orgId: string): Promise<DesignSystemCatalogEntry[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const systems = await client.query<{
        id: string;
        slug: string;
        name: string;
        description: string;
        lifecycle: string;
        default_channel: string;
      }>(
        `SELECT id, slug, name, description, lifecycle, default_channel
           FROM design_systems WHERE org_id = $1 ORDER BY updated_at DESC, id ASC`,
        [orgId],
      );
      const entries: DesignSystemCatalogEntry[] = [];
      for (const system of systems.rows) {
        const releases = await client.query<{
          id: string;
          version: number;
          contract_digest: string;
          canonical_artifact_id: string | null;
          published_at: Date | null;
        }>(
          `SELECT id, version, contract_digest, canonical_artifact_id, published_at
             FROM design_system_releases
            WHERE org_id = $1 AND design_system_id = $2 AND state = 'published'
            ORDER BY version DESC`,
          [orgId, system.id],
        );
        const channels = await client.query<{ channel: string; release_id: string }>(
          `SELECT channel, release_id FROM design_release_channels
            WHERE org_id = $1 AND design_system_id = $2 ORDER BY channel ASC`,
          [orgId, system.id],
        );
        const reuse = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM project_design_bindings
            WHERE org_id = $1 AND design_system_id = $2`,
          [orgId, system.id],
        );
        const head = releases.rows[0];
        entries.push({
          designSystemId: system.id,
          slug: system.slug,
          name: system.name,
          description: system.description,
          lifecycle: system.lifecycle,
          defaultChannel: system.default_channel,
          publishedReleaseCount: releases.rows.length,
          latestPublishedRelease:
            head === undefined || head.canonical_artifact_id === null
              ? null
              : {
                  releaseId: head.id,
                  version: head.version,
                  contractDigest: head.contract_digest,
                  canonicalArtifactId: head.canonical_artifact_id,
                  publishedAt: toIso(head.published_at),
                },
          channels: channels.rows.map((row) => ({ channel: row.channel, releaseId: row.release_id })),
          reuseCount: toCount(reuse.rows[0]?.count ?? 0),
        });
      }
      return entries;
    });
  }

  /** Read a project's current reuse binding, or null when unbound. */
  async getBinding(orgId: string, projectId: string): Promise<ProjectDesignBinding | null> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<BindingDbRow>(
        `SELECT ${BINDING_COLUMNS} FROM project_design_bindings WHERE org_id = $1 AND project_id = $2`,
        [orgId, projectId],
      );
      const row = rows.rows[0];
      return row === undefined ? null : mapBindingRow(row);
    });
  }

  /**
   * Upsert a project's reuse binding after validating the target resolves to a
   * PUBLISHED same-org release (a channel pin must name an existing channel whose
   * release is published). The composite FKs already forbid a cross-org target;
   * this adds the published-state guard the FK cannot express. RLS scopes every
   * statement to the caller's org.
   */
  async putBinding(input: PutDesignBindingInput): Promise<ProjectDesignBinding> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const system = await client.query(`SELECT 1 FROM design_systems WHERE org_id = $1 AND id = $2`, [
        input.orgId,
        input.designSystemId,
      ]);
      if (system.rowCount === 0) {
        throw new DesignBindingTargetError(input.orgId, `design system '${input.designSystemId}' not found`);
      }
      let pinnedReleaseId: string | null = null;
      let channel: string | null = null;
      if (input.pinMode === "release") {
        pinnedReleaseId = input.pinnedReleaseId ?? null;
        if (pinnedReleaseId === null) throw new DesignBindingTargetError(input.orgId, "release pin needs a release id");
        const release = await client.query(
          `SELECT 1 FROM design_system_releases
            WHERE org_id = $1 AND id = $2 AND design_system_id = $3 AND state = 'published'`,
          [input.orgId, pinnedReleaseId, input.designSystemId],
        );
        if (release.rowCount === 0) {
          throw new DesignBindingTargetError(
            input.orgId,
            `release '${pinnedReleaseId}' is not a published release of the system`,
          );
        }
      } else {
        channel = input.channel ?? null;
        if (channel === null) throw new DesignBindingTargetError(input.orgId, "channel pin needs a channel name");
        const resolved = await client.query(
          `SELECT 1 FROM design_release_channels channel_row
             JOIN design_system_releases release
               ON release.org_id = channel_row.org_id AND release.id = channel_row.release_id
            WHERE channel_row.org_id = $1 AND channel_row.design_system_id = $2
              AND channel_row.channel = $3 AND release.state = 'published'`,
          [input.orgId, input.designSystemId, channel],
        );
        if (resolved.rowCount === 0) {
          throw new DesignBindingTargetError(
            input.orgId,
            `channel '${channel}' does not resolve to a published release`,
          );
        }
      }
      // Read-back is RETURNING on the SAME transaction/client — a nested
      // runWithOrgScope would open a separate txn that cannot see this uncommitted row.
      const upserted = await client.query<BindingDbRow>(
        `INSERT INTO project_design_bindings
           (org_id, project_id, design_system_id, pin_mode, pinned_release_id, channel, bound_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (org_id, project_id) DO UPDATE
           SET design_system_id = EXCLUDED.design_system_id,
               pin_mode = EXCLUDED.pin_mode,
               pinned_release_id = EXCLUDED.pinned_release_id,
               channel = EXCLUDED.channel,
               bound_by = EXCLUDED.bound_by,
               updated_at = now()
         RETURNING ${BINDING_COLUMNS}`,
        [input.orgId, input.projectId, input.designSystemId, input.pinMode, pinnedReleaseId, channel, input.boundBy],
      );
      const row = upserted.rows[0];
      if (row === undefined) throw new DesignBindingTargetError(input.orgId, "binding was not readable after upsert");
      return mapBindingRow(row);
    });
  }

  /** List the EXPORT-kind files in an artifact bundle (the downloadable projections). */
  async listExportFiles(orgId: string, artifactId: string): Promise<DesignArtifactExportFile[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<{
        path: string;
        kind: string;
        media_type: string;
        digest: string;
        byte_size: string | number;
      }>(
        `SELECT file.path, file.kind, file.media_type, file.digest, file.byte_size
           FROM design_artifact_files file
           JOIN design_artifacts artifact
             ON artifact.org_id = file.org_id AND artifact.id = file.artifact_id
          WHERE file.org_id = $1 AND file.artifact_id = $2 AND file.kind = 'export'
          ORDER BY file.path ASC`,
        [orgId, artifactId],
      );
      return rows.rows.map((row) => ({
        path: row.path,
        kind: row.kind,
        mediaType: row.media_type,
        digest: row.digest,
        byteSize: toCount(row.byte_size),
      }));
    });
  }

  /** Read one export file's metadata (for a real byte download), or null when absent. */
  async getExportFile(orgId: string, artifactId: string, path: string): Promise<DesignArtifactExportFile | null> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<{
        path: string;
        kind: string;
        media_type: string;
        digest: string;
        byte_size: string | number;
      }>(
        `SELECT path, kind, media_type, digest, byte_size
           FROM design_artifact_files
          WHERE org_id = $1 AND artifact_id = $2 AND path = $3 AND kind = 'export'`,
        [orgId, artifactId, path],
      );
      const row = rows.rows[0];
      if (row === undefined) return null;
      return {
        path: row.path,
        kind: row.kind,
        mediaType: row.media_type,
        digest: row.digest,
        byteSize: toCount(row.byte_size),
      };
    });
  }
}
