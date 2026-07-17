import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { issueLoops } from "./schemaIssueLoops.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

export const symptomContracts = pgTable(
  "symptom_contracts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contractJson: jsonb("contract_json").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    proofPolicy: text("proof_policy"),
    target: jsonb("target"),
    sourceRevision: text("source_revision"),
    authorTaskId: text("author_task_id"),
    state: text("state").notNull(),
    baselineRequired: boolean("baseline_required").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("symptom_contracts_org_project_id_unique").on(table.orgId, table.projectId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "symptom_contracts_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "symptom_contracts_issue_loop_fk",
    }),
    index("symptom_contracts_org_id").on(table.orgId),
    index("symptom_contracts_org_loop").on(table.orgId, table.issueLoopId),
    check("symptom_contracts_canonical_hash_check", sql`${table.canonicalHash} ~ '^sha256:[0-9a-f]{64}$'`),
    check(
      "symptom_contracts_state_check",
      sql`${table.state} IN ('draft','authored','validated','superseded','authoring_failed')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const symptomContractFragments = pgTable(
  "symptom_contract_fragments",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    contractId: text("contract_id").notNull(),
    fragmentId: text("fragment_id").notNull(),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    conformanceResult: text("conformance_result"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.contractId, table.fragmentId] }),
    foreignKey({
      columns: [table.orgId, table.contractId],
      foreignColumns: [symptomContracts.orgId, symptomContracts.id],
      name: "symptom_contract_fragments_contract_fk",
    }),
    index("symptom_contract_fragments_org_id").on(table.orgId),
    check("symptom_contract_fragments_content_hash_check", sql`${table.contentHash} ~ '^sha256:[0-9a-f]{64}$'`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
