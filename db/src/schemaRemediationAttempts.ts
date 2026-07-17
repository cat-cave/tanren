import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects, runs, specs } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { issueLoops } from "./schemaIssueLoops.js";

// bh cluster barrier: each repair attempt is an immutable causal record. A
// later repair is a new row, linked to (never overwriting) its predecessor.
export const remediationAttempts = pgTable(
  "remediation_attempts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    iteration: integer("iteration").notNull(),
    hypothesis: text("hypothesis").notNull(),
    specId: text("spec_id"),
    runId: text("run_id"),
    prRef: text("pr_ref"),
    mergeSha: text("merge_sha"),
    priorAttemptId: text("prior_attempt_id"),
    failureSignature: text("failure_signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("remediation_attempts_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "remediation_attempts_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "remediation_attempts_issue_loop_fk",
    }),
    foreignKey({ columns: [table.specId], foreignColumns: [specs.specId], name: "remediation_attempts_spec_fk" }),
    foreignKey({ columns: [table.runId], foreignColumns: [runs.runId], name: "remediation_attempts_run_fk" }),
    foreignKey({
      columns: [table.orgId, table.priorAttemptId],
      foreignColumns: [table.orgId, table.id],
      name: "remediation_attempts_prior_attempt_fk",
    }),
    check("remediation_attempts_iteration_check", sql`${table.iteration} >= 1`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
