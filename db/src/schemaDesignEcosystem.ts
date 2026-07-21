// ds-8 — cross-org design ecosystem bridge. Private design rows remain strictly
// org-scoped; the only cross-org coordinate is this metadata-only public projection.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { designSystemReleases, designSystems } from "./schemaDesignSystems.js";

const sha256Pattern = sql.raw("'^sha256:[0-9a-f]{64}$'");
const nonblank = (column: AnyPgColumn) => sql`btrim(${column}) <> ''`;

/** The ordinary tenant policy used by every destination/source-owned table here. */
function ecosystemOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", { for: "all", using: predicate, withCheck: predicate });
}

/**
 * Sanitized, system-owned release projection. `source_org_id` is mutation
 * authority only and never appears in the sanitized public service response;
 * it otherwise has no private release/artifact/object-store coordinate.
 */
export const publishedDesignSystemReleases = pgTable(
  "published_design_system_releases",
  {
    publicationId: text("publication_id").primaryKey(),
    sourceOrgId: text("source_org_id")
      .notNull()
      .references(() => organizations.id),
    publicSlug: text("public_slug").notNull(),
    sourceReleaseDigest: text("source_release_digest").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    safePreviewDigest: text("safe_preview_digest").notNull(),
    license: text("license").notNull(),
    attribution: jsonb("attribution")
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text("state").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("published_design_system_releases_public_slug_unique").on(table.publicSlug),
    check("published_design_system_releases_state_check", sql`${table.state} IN ('published','revoked')`),
    check(
      "published_design_system_releases_release_digest_check",
      sql`${table.sourceReleaseDigest} ~ ${sha256Pattern}`,
    ),
    check("published_design_system_releases_manifest_digest_check", sql`${table.manifestDigest} ~ ${sha256Pattern}`),
    check("published_design_system_releases_preview_digest_check", sql`${table.safePreviewDigest} ~ ${sha256Pattern}`),
    check("published_design_system_releases_slug_nonblank_check", nonblank(table.publicSlug)),
    check("published_design_system_releases_license_nonblank_check", nonblank(table.license)),
    check(
      "published_design_system_releases_revocation_state_check",
      sql`(${table.state} = 'published' AND ${table.revokedAt} IS NULL) OR (${table.state} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    pgPolicy("published_design_system_releases_public_read", {
      for: "select",
      using: sql`${table.state} = 'published' AND ${table.revokedAt} IS NULL`,
    }),
    pgPolicy("published_design_system_releases_source_org_insert", {
      for: "insert",
      withCheck: sql`${table.sourceOrgId} = current_setting('app.current_org_id', true)`,
    }),
    pgPolicy("published_design_system_releases_source_org_update", {
      for: "update",
      using: sql`${table.sourceOrgId} = current_setting('app.current_org_id', true)`,
      withCheck: sql`${table.sourceOrgId} = current_setting('app.current_org_id', true)`,
    }),
    pgPolicy("published_design_system_releases_source_org_delete", {
      for: "delete",
      using: sql`${table.sourceOrgId} = current_setting('app.current_org_id', true)`,
    }),
  ],
).enableRLS();

/** A source-owned, hash-only one-time/limited share authorization. */
export const designShareLinks = pgTable(
  "design_share_links",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    publicationId: text("publication_id").notNull(),
    sourceReleaseId: text("source_release_id").notNull(),
    sourceReleaseDigest: text("source_release_digest").notNull(),
    recipientOrgId: text("recipient_org_id")
      .notNull()
      .references(() => organizations.id),
    tokenHash: text("token_hash").notNull(),
    permission: text("permission").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redemptionCount: integer("redemption_count").notNull().default(0),
    redemptionLimit: integer("redemption_limit").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [publishedDesignSystemReleases.publicationId],
      name: "design_share_links_publication_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.sourceReleaseId],
      foreignColumns: [designSystemReleases.orgId, designSystemReleases.id],
      name: "design_share_links_source_release_fk",
    }),
    uniqueIndex("design_share_links_token_hash_unique").on(table.tokenHash),
    index("design_share_links_org_id").on(table.orgId),
    index("design_share_links_recipient_org").on(table.recipientOrgId),
    check("design_share_links_release_digest_check", sql`${table.sourceReleaseDigest} ~ ${sha256Pattern}`),
    check("design_share_links_token_hash_check", sql`${table.tokenHash} ~ ${sha256Pattern}`),
    check("design_share_links_permission_check", sql`${table.permission} IN ('import','fork')`),
    check(
      "design_share_links_count_check",
      sql`${table.redemptionCount} >= 0 AND ${table.redemptionLimit} > 0 AND ${table.redemptionCount} <= ${table.redemptionLimit}`,
    ),
    ecosystemOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** A destination-owned, revocable grant. It references only the safe projection. */
export const designSystemGrants = pgTable(
  "design_system_grants",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    publicationId: text("publication_id").notNull(),
    allowedReleaseDigest: text("allowed_release_digest").notNull(),
    capability: text("capability").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    importPolicy: jsonb("import_policy")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [publishedDesignSystemReleases.publicationId],
      name: "design_system_grants_publication_fk",
    }),
    index("design_system_grants_org_id").on(table.orgId),
    uniqueIndex("design_system_grants_org_publication_unique").on(table.orgId, table.publicationId),
    uniqueIndex("design_system_grants_org_idempotency_unique").on(table.orgId, table.idempotencyKey),
    check("design_system_grants_release_digest_check", sql`${table.allowedReleaseDigest} ~ ${sha256Pattern}`),
    check("design_system_grants_capability_check", sql`${table.capability} IN ('import','fork')`),
    ecosystemOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Destination-owned lineage from a redeemed public projection to an owned fork. */
export const designImports = pgTable(
  "design_imports",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    publicationId: text("publication_id").notNull(),
    sourceReleaseDigest: text("source_release_digest").notNull(),
    designSystemId: text("design_system_id").notNull(),
    releaseId: text("release_id").notNull(),
    attribution: jsonb("attribution")
      .notNull()
      .default(sql`'{}'::jsonb`),
    syncPolicy: text("sync_policy").notNull(),
    lastSeenUpstream: text("last_seen_upstream").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [publishedDesignSystemReleases.publicationId],
      name: "design_imports_publication_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.designSystemId],
      foreignColumns: [designSystems.orgId, designSystems.id],
      name: "design_imports_system_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.releaseId],
      foreignColumns: [designSystemReleases.orgId, designSystemReleases.id],
      name: "design_imports_release_fk",
    }),
    index("design_imports_org_id").on(table.orgId),
    uniqueIndex("design_imports_org_publication_unique").on(table.orgId, table.publicationId),
    check("design_imports_release_digest_check", sql`${table.sourceReleaseDigest} ~ ${sha256Pattern}`),
    check("design_imports_sync_policy_check", sql`${table.syncPolicy} IN ('immutable_fork','manual_sync')`),
    check("design_imports_upstream_nonblank_check", nonblank(table.lastSeenUpstream)),
    ecosystemOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Quarantined Figma/registry snapshot receipt; never stores provider credentials. */
export const designExternalImports = pgTable(
  "design_external_imports",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    source: text("source").notNull(),
    locator: text("locator").notNull(),
    externalRevision: text("external_revision").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    receipt: jsonb("receipt").notNull(),
    disposition: text("disposition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("design_external_imports_org_id").on(table.orgId),
    uniqueIndex("design_external_imports_org_source_locator_revision_unique").on(
      table.orgId,
      table.source,
      table.locator,
      table.externalRevision,
    ),
    check("design_external_imports_source_check", sql`${table.source} IN ('figma','registry')`),
    check(
      "design_external_imports_disposition_check",
      sql`${table.disposition} IN ('quarantined','candidate','rejected')`,
    ),
    check("design_external_imports_snapshot_digest_check", sql`${table.snapshotDigest} ~ ${sha256Pattern}`),
    check("design_external_imports_receipt_digest_check", sql`${table.receiptDigest} ~ ${sha256Pattern}`),
    check("design_external_imports_locator_nonblank_check", nonblank(table.locator)),
    check("design_external_imports_revision_nonblank_check", nonblank(table.externalRevision)),
    ecosystemOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
