import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
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
import { authorityDecisionsReference, casArtifactsReference, proofBundlesReference } from "./schemaSpineReferences.js";

// mq-15 append-only merge-train artifact projection. Exactly one row per completed
// land group (unique on `(org_id, land_group_id)`); it seals only after a matching
// authority decision, proof root, receipt, verified deploy, and proof-backed demo.
// Every digest column carries the sha256 shape check; the row is immutable (the
// enforce trigger is appended in the migration). Composite FKs bind the projection
// to the already-authoritative land group, authority decision, sealed proof bundle,
// and CAS-stored manifest bytes so a dangling projection cannot exist.
export const mergeTrainArtifacts = pgTable(
  "merge_train_artifacts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    landGroupId: text("land_group_id").notNull(),
    authorityDecisionId: text("authority_decision_id").notNull(),
    integrationNodeId: text("integration_node_id").notNull(),
    proofRoot: text("proof_root").notNull(),
    receiptAuditId: text("receipt_audit_id").notNull(),
    receiptMainSha: text("receipt_main_sha").notNull(),
    deployProvider: text("deploy_provider").notNull(),
    deployAppId: text("deploy_app_id").notNull(),
    deployDeploymentId: text("deploy_deployment_id").notNull(),
    demoSurfaceKind: text("demo_surface_kind").notNull(),
    demoBehaviorCount: integer("demo_behavior_count").notNull(),
    demoPassed: integer("demo_passed").notNull(),
    bundleId: text("bundle_id").notNull(),
    bundleDigest: text("bundle_digest").notNull(),
    bytesDigest: text("bytes_digest").notNull(),
    contentHash: text("content_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("merge_train_artifacts_org_land_group_unique").on(table.orgId, table.landGroupId),
    foreignKey({
      columns: [table.orgId, table.landGroupId],
      foreignColumns: [landGroups.orgId, landGroups.id],
      name: "merge_train_artifacts_land_group_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.authorityDecisionId],
      foreignColumns: [authorityDecisionsReference.orgId, authorityDecisionsReference.id],
      name: "merge_train_artifacts_decision_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bundleId],
      foreignColumns: [proofBundlesReference.orgId, proofBundlesReference.id],
      name: "merge_train_artifacts_bundle_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bytesDigest],
      foreignColumns: [casArtifactsReference.orgId, casArtifactsReference.digest],
      name: "merge_train_artifacts_bytes_cas_fk",
    }),
    check("merge_train_artifacts_proof_root_check", sql`${table.proofRoot} ~ '^sha256:[0-9a-f]{64}$'`),
    check("merge_train_artifacts_bundle_digest_check", sql`${table.bundleDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check("merge_train_artifacts_bytes_digest_check", sql`${table.bytesDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check("merge_train_artifacts_content_hash_check", sql`${table.contentHash} ~ '^sha256:[0-9a-f]{64}$'`),
    index("merge_train_artifacts_org_id").on(table.orgId),
    index("merge_train_artifacts_org_project").on(table.orgId, table.projectId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
