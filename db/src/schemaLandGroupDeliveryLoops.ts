import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { landGroups } from "./schemaLandGroups.js";
import { releaseInstancesReference } from "./schemaSpineReferences.js";

/**
 * mq-13 — one durable, proof-backed DELIVERY loop per COMPLETED land group. FORCE-RLS,
 * org-scoped. `(org_id, land_group_id)` is UNIQUE (exactly ONE delivery receipt/artifact per
 * completed group — the idempotency boundary). Release lineage (preview / production / rollback)
 * is captured as nullable composite FKs to `release_instances`; the land group + project + org
 * are composite/single-col FKs to existing tables. `land_groups` has NO project_id, so
 * `project_id` here is derived + verified through the authority decision / member run before
 * persisting (see landGroupDeliveryReads.ts) — never a nonexistent group→project FK.
 */
export const landGroupDeliveryLoops = pgTable(
  "land_group_delivery_loops",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    landGroupId: text("land_group_id").notNull(),
    mainSha: text("main_sha").notNull(),
    state: text("state").notNull(),
    disposition: text("disposition").notNull(),
    artifactDigest: text("artifact_digest"),
    previewReleaseInstanceId: text("preview_release_instance_id"),
    productionReleaseInstanceId: text("production_release_instance_id"),
    rollbackReleaseInstanceId: text("rollback_release_instance_id"),
    attributedRunId: text("attributed_run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    fencingToken: text("fencing_token").notNull(),
    receipt: jsonb("receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("land_group_delivery_loops_org_land_group_unique").on(table.orgId, table.landGroupId),
    foreignKey({
      columns: [table.orgId, table.landGroupId],
      foreignColumns: [landGroups.orgId, landGroups.id],
      name: "land_group_delivery_loops_land_group_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.previewReleaseInstanceId],
      foreignColumns: [releaseInstancesReference.orgId, releaseInstancesReference.id],
      name: "land_group_delivery_loops_preview_release_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.productionReleaseInstanceId],
      foreignColumns: [releaseInstancesReference.orgId, releaseInstancesReference.id],
      name: "land_group_delivery_loops_production_release_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.rollbackReleaseInstanceId],
      foreignColumns: [releaseInstancesReference.orgId, releaseInstancesReference.id],
      name: "land_group_delivery_loops_rollback_release_fk",
    }),
    check(
      "land_group_delivery_loops_artifact_digest_check",
      sql`${table.artifactDigest} IS NULL OR ${table.artifactDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    index("land_group_delivery_loops_org_id").on(table.orgId),
    index("land_group_delivery_loops_org_project").on(table.orgId, table.projectId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
