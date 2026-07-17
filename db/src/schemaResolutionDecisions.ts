import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { issueLoops } from "./schemaIssueLoops.js";
import { resolutionJobs } from "./schemaResolutionJobs.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// bh cluster barrier: fail-closed authority inputs are append-only snapshots.
export const resolutionDecisions = pgTable(
  "resolution_decisions",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    resolutionJobId: text("resolution_job_id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    decision: text("decision").notNull(),
    decisionReasons: jsonb("decision_reasons").$type<string[]>().notNull(),
    authorityVersion: text("authority_version").notNull(),
    contractId: text("contract_id").notNull(),
    releaseInstanceId: text("release_instance_id"),
    verificationRunId: text("verification_run_id"),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("resolution_decisions_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "resolution_decisions_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.resolutionJobId],
      foreignColumns: [resolutionJobs.orgId, resolutionJobs.id],
      name: "resolution_decisions_resolution_job_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "resolution_decisions_issue_loop_fk",
    }),
    check(
      "resolution_decisions_decision_check",
      sql`${table.decision} IN ('authorized','blocked','needs_attention','waived')`,
    ),
    check("resolution_decisions_input_snapshot_hash_check", sql`${table.inputSnapshotHash} ~ ${digestPattern}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
