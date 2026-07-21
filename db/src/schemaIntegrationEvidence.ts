import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";
import { deliveryRunBindings } from "./schemaIntegrationOperations.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

/** Immutable pre-deploy generation attachment for an authorized merge SHA. */
export const integrationRuntimeAttachments = pgTable(
  "integration_runtime_attachments",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    deliveryRunId: text("delivery_run_id").notNull(),
    bindingId: text("binding_id").notNull(),
    bindingGeneration: integer("binding_generation").notNull(),
    deploySha: text("deploy_sha").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.deliveryRunId, table.bindingId, table.bindingGeneration] }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.deliveryRunId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        deliveryRunBindings.orgId,
        deliveryRunBindings.projectId,
        deliveryRunBindings.deliveryRunId,
        deliveryRunBindings.bindingId,
        deliveryRunBindings.bindingGeneration,
      ],
      name: "integration_runtime_attachments_delivery_binding_fk",
    }),
    index("integration_runtime_attachments_org_id").on(table.orgId),
    check("integration_runtime_attachments_generation_check", sql`${table.bindingGeneration} >= 1`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Redacted durable refusal when an integration-evidence join cannot seal. */
export const integrationEvidenceFailures = pgTable(
  "integration_evidence_failures",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    deliveryRunId: text("delivery_run_id").notNull(),
    bindingId: text("binding_id").notNull(),
    bindingGeneration: integer("binding_generation").notNull(),
    classification: text("classification").notNull(),
    redactedDetail: text("redacted_detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("integration_evidence_failures_coordinate_unique").on(
      table.orgId,
      table.deliveryRunId,
      table.bindingId,
      table.bindingGeneration,
      table.classification,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId, table.deliveryRunId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        deliveryRunBindings.orgId,
        deliveryRunBindings.projectId,
        deliveryRunBindings.deliveryRunId,
        deliveryRunBindings.bindingId,
        deliveryRunBindings.bindingGeneration,
      ],
      name: "integration_evidence_failures_delivery_binding_fk",
    }),
    index("integration_evidence_failures_org_id").on(table.orgId),
    check("integration_evidence_failures_generation_check", sql`${table.bindingGeneration} >= 1`),
    check(
      "integration_evidence_failures_classification_check",
      sql`${table.classification} IN ('grant_revoked','correlation_join_mismatch','evidence_unavailable')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
