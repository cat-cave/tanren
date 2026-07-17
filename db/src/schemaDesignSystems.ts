// ds-0 — the design-system SCHEMA FOUNDATION (mission-complete design bucket).
//
// The org-scoped, RLS-isolated release/artifact backbone every downstream design
// node (ds-1..8) builds against. It establishes the shared `design_system_*` /
// `design_artifact*` vocabulary + tenant-isolation backbone the way in-1
// established `integration_*` — a reusable, immutable, org-owned design-system
// family (`design_systems`), its immutable versioned RELEASES
// (`design_system_releases`), the CHANNEL pointers that promote a validated
// release (`design_release_channels`), and the content-addressed ARTIFACT
// metadata + files those releases resolve to (`design_artifacts`,
// `design_artifact_files`).
//
// SCOPE (foundation only): this is the release/artifact/channel substrate. The
// downstream design tables the spec's §3 data model enumerates — fragment
// releases + dependencies, curations + candidates, token/component indexes,
// validation runs + evidence, exports, project bindings, and the cross-org
// sharing/grants/imports/public-projection tier — are each OWNED by the node
// that needs them (ds-1..8) and FK into THIS backbone. They are deliberately NOT
// created here (keeping ds-0 a light foundation, not a 400-file slab).
//
// TENANCY — every table carries `org_id`, is `.enableRLS()` (drizzle emits the
// ENABLE + deny-by-default `rls_org_isolation` policy; the migration hand-appends
// `FORCE ROW LEVEL SECURITY`), and every cross-table foreign key is COMPOSITE on
// `org_id` — a design system/release/artifact from another tenant is impossible
// to reference even if an application check regresses. A design system is PRIVATE
// to its owning org; cross-org sharing (ds-8) is a separate sanitized projection,
// never `OR visibility='public'` on these tenant policies.
//
// PROOF KEYS — `contract_digest`, the artifact `digest` (a manifest content
// address), and per-file `digest` are all `sha256:[0-9a-f]{64}` CHECK-constrained
// content addresses. The `designProofKey.ts` derivation composes release/fragment/
// adapter/environment/scenario/artifact digests into the reuse key ds-4/ds-6 gate
// on; these columns are the persisted anchors for that key.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
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

const sha256Pattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

/** Drizzle-owned deny-by-default tenant policy for every design-system table. */
function designOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", {
    for: "all",
    using: predicate,
    withCheck: predicate,
  });
}

// ---------------------------------------------------------------------------
// design_systems — the stable family identity. Never stores mutable "current
// tokens"; the tokens live on immutable releases. `(org_id, slug)` is the org's
// stable handle for the family.
// ---------------------------------------------------------------------------
export const designSystems = pgTable(
  "design_systems",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    lifecycle: text("lifecycle").notNull().default("draft"),
    defaultChannel: text("default_channel").notNull().default("stable"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("design_systems_org_slug_unique").on(table.orgId, table.slug),
    index("design_systems_org_id").on(table.orgId),
    check("design_systems_lifecycle_check", sql`${table.lifecycle} IN ('draft','active','archived')`),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// design_artifacts — content-addressed artifact METADATA (not the bytes). The
// bytes live behind the ArtifactStore contract (ds-1); Postgres holds the digest,
// media type, manifest version, object-store key, size, and retention/quarantine
// policy. `(org_id, digest)` is unique — the content address is the reuse key.
// Defined before releases so the release → canonical-artifact composite FK can
// reference it.
// ---------------------------------------------------------------------------
export const designArtifacts = pgTable(
  "design_artifacts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    designSystemId: text("design_system_id"),
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    objectStoreKey: text("object_store_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    // The validated ds-2 Writer projection derived from the immutable artifact.
    // It lets a run hydrate token/catalog guidance without an object-store read.
    webWriterContext: jsonb("web_writer_context"),
    encryptionKeyRef: text("encryption_key_ref"),
    retentionClass: text("retention_class").notNull().default("standard"),
    quarantined: boolean("quarantined").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.designSystemId],
      foreignColumns: [designSystems.orgId, designSystems.id],
      name: "design_artifacts_system_fk",
    }),
    uniqueIndex("design_artifacts_org_id_unique").on(table.orgId, table.id),
    uniqueIndex("design_artifacts_org_digest_unique").on(table.orgId, table.digest),
    index("design_artifacts_org_id").on(table.orgId),
    check("design_artifacts_digest_check", sql`${table.digest} ~ ${sha256Pattern}`),
    check("design_artifacts_manifest_version_check", sql`${table.manifestVersion} >= 1`),
    check("design_artifacts_byte_size_check", sql`${table.byteSize} >= 0`),
    check("design_artifacts_retention_check", sql`${table.retentionClass} IN ('ephemeral','standard','durable')`),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// design_system_releases — the immutable, versioned release. Carries the design
// CONTRACT lineage (id/version/digest), the manifest schema version, and the
// canonical artifact the release resolves to. Immutable once published: the
// `published`/`deprecated` states require published_at + published_by + a
// canonical artifact.
// ---------------------------------------------------------------------------
export const designSystemReleases = pgTable(
  "design_system_releases",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    designSystemId: text("design_system_id").notNull(),
    version: integer("version").notNull(),
    parentReleaseId: text("parent_release_id"),
    state: text("state").notNull().default("draft"),
    contractId: text("contract_id").notNull(),
    contractVersion: integer("contract_version").notNull(),
    contractDigest: text("contract_digest").notNull(),
    manifestSchemaVersion: integer("manifest_schema_version").notNull(),
    canonicalArtifactId: text("canonical_artifact_id"),
    compatibilitySummary: jsonb("compatibility_summary")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: text("created_by").notNull(),
    publishedBy: text("published_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.designSystemId],
      foreignColumns: [designSystems.orgId, designSystems.id],
      name: "design_system_releases_system_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.canonicalArtifactId],
      foreignColumns: [designArtifacts.orgId, designArtifacts.id],
      name: "design_system_releases_artifact_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.parentReleaseId],
      foreignColumns: [table.orgId, table.id],
      name: "design_system_releases_parent_fk",
    }),
    uniqueIndex("design_system_releases_version_unique").on(table.orgId, table.designSystemId, table.version),
    uniqueIndex("design_system_releases_org_id_unique").on(table.orgId, table.id),
    index("design_system_releases_org_system").on(table.orgId, table.designSystemId),
    check("design_system_releases_version_check", sql`${table.version} >= 1`),
    check("design_system_releases_contract_version_check", sql`${table.contractVersion} >= 1`),
    check("design_system_releases_manifest_version_check", sql`${table.manifestSchemaVersion} >= 1`),
    check("design_system_releases_contract_digest_check", sql`${table.contractDigest} ~ ${sha256Pattern}`),
    check(
      "design_system_releases_state_check",
      sql`${table.state} IN ('draft','validated','published','deprecated','quarantined')`,
    ),
    // Published immutability invariant: a published/deprecated release must carry
    // its provenance + the canonical artifact it resolves to; a non-published
    // release must not carry publication provenance.
    check(
      "design_system_releases_published_check",
      sql`(${table.state} IN ('published','deprecated') AND ${table.publishedAt} IS NOT NULL AND ${table.publishedBy} IS NOT NULL AND ${table.canonicalArtifactId} IS NOT NULL) OR (${table.state} IN ('draft','validated','quarantined') AND ${table.publishedAt} IS NULL AND ${table.publishedBy} IS NULL)`,
    ),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// design_release_channels — `(org_id, design_system_id, channel)` → a release.
// Promotion is CAS-protected + audited by the engine (ds-5); this table is the
// pointer target. Channels such as experimental / candidate / stable.
// ---------------------------------------------------------------------------
export const designReleaseChannels = pgTable(
  "design_release_channels",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    designSystemId: text("design_system_id").notNull(),
    channel: text("channel").notNull(),
    releaseId: text("release_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.designSystemId, table.channel] }),
    foreignKey({
      columns: [table.orgId, table.designSystemId],
      foreignColumns: [designSystems.orgId, designSystems.id],
      name: "design_release_channels_system_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.releaseId],
      foreignColumns: [designSystemReleases.orgId, designSystemReleases.id],
      name: "design_release_channels_release_fk",
    }),
    index("design_release_channels_org_id").on(table.orgId),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// design_artifact_files — the files inside an artifact bundle. Normalized path is
// unique per artifact; no traversal or case-collision ambiguity (enforced by the
// offline validator + the store insert). Composite FK on (org_id, artifact_id).
// ---------------------------------------------------------------------------
export const designArtifactFiles = pgTable(
  "design_artifact_files",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    artifactId: text("artifact_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    mediaType: text("media_type").notNull(),
    digest: text("digest").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    executable: boolean("executable").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.artifactId, table.path] }),
    foreignKey({
      columns: [table.orgId, table.artifactId],
      foreignColumns: [designArtifacts.orgId, designArtifacts.id],
      name: "design_artifact_files_artifact_fk",
    }),
    index("design_artifact_files_org_artifact").on(table.orgId, table.artifactId),
    check("design_artifact_files_digest_check", sql`${table.digest} ~ ${sha256Pattern}`),
    check("design_artifact_files_byte_size_check", sql`${table.byteSize} >= 0`),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
