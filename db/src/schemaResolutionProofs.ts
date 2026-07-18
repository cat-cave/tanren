import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { issueLoops } from "./schemaIssueLoops.js";
import { resolutionDecisions } from "./schemaResolutionDecisions.js";
import { resolutionJobs } from "./schemaResolutionJobs.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// bh-14a — sealed resolution proofs are append-only tamper-evident hash-chains
// over an issue loop's terminal evidence. A proof is written once (blocked
// terminal, or authorized/waived verified_closed terminal) and never mutated;
// the append-only immutability trigger + RLS live in migration 0078.
export const resolutionProofs = pgTable(
  "resolution_proofs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    resolutionJobId: text("resolution_job_id").notNull(),
    resolutionDecisionId: text("resolution_decision_id").notNull(),
    terminal: text("terminal").notNull(),
    proofHash: text("proof_hash").notNull(),
    proofJson: jsonb("proof_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("resolution_proofs_org_id").on(table.orgId),
    index("resolution_proofs_org_project_loop").on(table.orgId, table.projectId, table.issueLoopId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "resolution_proofs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "resolution_proofs_issue_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.resolutionJobId],
      foreignColumns: [resolutionJobs.orgId, resolutionJobs.id],
      name: "resolution_proofs_resolution_job_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.resolutionDecisionId],
      foreignColumns: [resolutionDecisions.orgId, resolutionDecisions.id],
      name: "resolution_proofs_resolution_decision_fk",
    }),
    check("resolution_proofs_terminal_check", sql`${table.terminal} IN ('authorized_verified_closed','blocked')`),
    check("resolution_proofs_proof_hash_check", sql`${table.proofHash} ~ ${digestPattern}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
