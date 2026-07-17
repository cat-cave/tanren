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
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { issueLoops } from "./schemaIssueLoops.js";
import { releaseInstancesReference } from "./schemaSpineReferences.js";
import { symptomContracts } from "./schemaSymptomContracts.js";

// bh cluster barrier: jobs are the mutable claim/lease aggregate that later
// stage owners share. Decisions and attempts stay separate immutable ledgers.
export const resolutionJobs = pgTable(
  "resolution_jobs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    contractId: text("contract_id").notNull(),
    releaseInstanceId: text("release_instance_id"),
    stage: text("stage").notNull(),
    state: text("state").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiry: timestamp("lease_expiry", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    attempt: integer("attempt").notNull(),
    priorAttemptId: text("prior_attempt_id"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("resolution_jobs_org_project_id_unique").on(table.orgId, table.projectId, table.id),
    uniqueIndex("resolution_jobs_org_idempotency_key_unique").on(table.orgId, table.idempotencyKey),
    index("resolution_jobs_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "resolution_jobs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "resolution_jobs_issue_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.contractId],
      foreignColumns: [symptomContracts.orgId, symptomContracts.id],
      name: "resolution_jobs_contract_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.releaseInstanceId],
      foreignColumns: [releaseInstancesReference.orgId, releaseInstancesReference.id],
      name: "resolution_jobs_release_instance_fk",
    }),
    check("resolution_jobs_stage_check", sql`${table.stage} IN ('baseline','production','counterfactual','soak')`),
    check(
      "resolution_jobs_state_check",
      sql`${table.state} IN ('queued','running','retryable','paused','authorized','blocked','needs_attention','waived','completed')`,
    ),
    check("resolution_jobs_attempt_check", sql`${table.attempt} >= 1`),
    check(
      "resolution_jobs_running_lease_check",
      sql`${table.state} <> 'running' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiry} IS NOT NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
