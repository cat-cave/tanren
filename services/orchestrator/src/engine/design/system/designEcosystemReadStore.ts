// ds-8 — destination Studio projection. Only sanitized publication lineage is
// joined; no source release/artifact/object-store coordinate is ever returned.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { ExternalDesignImportReceiptV1Schema, type ExternalDesignImportReceiptV1 } from "./designEcosystemContracts.js";
import { DesignEcosystemError } from "./designEcosystemService.js";

export interface DesignEcosystemStudioView {
  readonly grants: readonly {
    readonly id: string;
    readonly capability: "import" | "fork";
    readonly expiresAt: string;
    readonly availability: "available" | "revoked" | "unavailable";
    readonly publicSlug: string | null;
  }[];
  readonly imports: readonly {
    readonly id: string;
    readonly publicSlug: string | null;
    readonly releaseId: string;
    readonly syncPolicy: "immutable_fork" | "manual_sync";
    readonly lastSeenUpstream: string;
    readonly availability: "available" | "revoked" | "unavailable";
  }[];
  readonly externalImports: readonly { readonly id: string; readonly receipt: ExternalDesignImportReceiptV1 }[];
}

export class DesignEcosystemReadStore {
  constructor(private readonly pool: pg.Pool) {}

  /** System scope is narrow and explicit; all three statements constrain destination org. */
  async listStudio(orgId: string): Promise<DesignEcosystemStudioView> {
    return runWithSystemScope(this.pool, async (client) => {
      const grants = await client.query<{
        id: string;
        capability: string;
        expires_at: Date | string;
        public_slug: string | null;
        state: string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT grant.id, grant.capability, grant.expires_at, publication.public_slug,
                publication.state, publication.revoked_at
           FROM design_system_grants grant
           LEFT JOIN published_design_system_releases publication ON publication.publication_id = grant.publication_id
          WHERE grant.org_id = $1 ORDER BY grant.created_at DESC, grant.id ASC`,
        [orgId],
      );
      const imports = await client.query<{
        id: string;
        release_id: string;
        sync_policy: string;
        last_seen_upstream: string;
        public_slug: string | null;
        state: string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT imported.id, imported.release_id, imported.sync_policy, imported.last_seen_upstream,
                publication.public_slug, publication.state, publication.revoked_at
           FROM design_imports imported
           LEFT JOIN published_design_system_releases publication ON publication.publication_id = imported.publication_id
          WHERE imported.org_id = $1 ORDER BY imported.created_at DESC, imported.id ASC`,
        [orgId],
      );
      const external = await client.query<{ id: string; receipt: unknown }>(
        `SELECT id, receipt FROM design_external_imports WHERE org_id = $1 ORDER BY updated_at DESC, id ASC`,
        [orgId],
      );
      return {
        grants: grants.rows.map((row) => ({
          id: row.id,
          capability: parseCapability(row.capability),
          expiresAt: iso(row.expires_at, "grant expiry"),
          availability: availability(row.state, row.revoked_at),
          publicSlug: row.public_slug,
        })),
        imports: imports.rows.map((row) => ({
          id: row.id,
          publicSlug: row.public_slug,
          releaseId: row.release_id,
          syncPolicy: parsePolicy(row.sync_policy),
          lastSeenUpstream: requiredText(row.last_seen_upstream, "upstream revision"),
          availability: availability(row.state, row.revoked_at),
        })),
        externalImports: external.rows.map((row) => ({ id: row.id, receipt: parseReceipt(row.id, row.receipt) })),
      };
    });
  }
}

function parseReceipt(id: string, value: unknown): ExternalDesignImportReceiptV1 {
  const parsed = ExternalDesignImportReceiptV1Schema.safeParse(value);
  if (!parsed.success) throw new DesignEcosystemError("blocked", `external import '${id}' receipt corrupt`);
  return parsed.data;
}
function parseCapability(value: string): "import" | "fork" {
  if (value === "import" || value === "fork") return value;
  throw new DesignEcosystemError("blocked", "grant capability corrupt");
}
function parsePolicy(value: string): "immutable_fork" | "manual_sync" {
  if (value === "immutable_fork" || value === "manual_sync") return value;
  throw new DesignEcosystemError("blocked", "import policy corrupt");
}
function availability(state: string | null, revokedAt: Date | string | null): "available" | "revoked" | "unavailable" {
  if (state === "published" && revokedAt === null) return "available";
  if (state === "revoked" || revokedAt !== null) return "revoked";
  return "unavailable";
}
function iso(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new DesignEcosystemError("blocked", `${label} corrupt`);
  return parsed.toISOString();
}
function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new DesignEcosystemError("blocked", `${label} corrupt`);
  return value;
}
