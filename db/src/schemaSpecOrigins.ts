import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, specs } from "./schemaCore.js";
import { issueLoops, sourceFindings } from "./schemaIssueLoops.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

export const specOrigins = pgTable(
  "spec_origins",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    specId: text("spec_id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    triageTaskId: text("triage_task_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    role: text("role").notNull(),
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "spec_origins_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "spec_origins_issue_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "spec_origins_project_fk",
    }),
    uniqueIndex("spec_origins_attempt_role_ordinal_unique").on(
      table.orgId,
      table.issueLoopId,
      table.attemptNumber,
      table.role,
      table.ordinal,
    ),
    index("spec_origins_org_id").on(table.orgId),
    check("spec_origins_role_check", sql`${table.role} IN ('primary_fix','repair','rollback','probe_capability','followup')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const specOriginFindings = pgTable(
  "spec_origin_findings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    specId: text("spec_id").notNull(),
    sourceFindingId: text("source_finding_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.specId, table.sourceFindingId] }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "spec_origin_findings_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.sourceFindingId],
      foreignColumns: [sourceFindings.orgId, sourceFindings.id],
      name: "spec_origin_findings_source_finding_fk",
    }),
    index("spec_origin_findings_org_id").on(table.orgId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
