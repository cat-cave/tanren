import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, runs, specs } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// A pending row is the durable write-ahead record for one GitHub branch CAS.
// It stays pending across worker restarts and is completed only after the
// matching github.branch.pushed event is durable.
export const githubPushIntents = pgTable(
  "github_push_intents",
  {
    intentId: text("intent_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    specId: text("spec_id").notNull(),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    intendedSha: text("intended_sha").notNull(),
    sourceRef: text("source_ref").notNull(),
    // NULL is the explicit predecessor for a proven-absent remote ref.
    leasePredecessorSha: text("lease_predecessor_sha"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "github_push_intents_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [runs.orgId, runs.runId],
      name: "github_push_intents_run_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "github_push_intents_spec_fk",
    }),
    check(
      "github_push_intents_status_check",
      sql`(${table.status} = 'pending' AND ${table.completedAt} IS NULL) OR (${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "github_push_intents_sha_check",
      sql`${table.intendedSha} ~ '^[0-9a-f]{40}$' AND ${table.sourceRef} ~ '^[0-9a-f]{40}$'`,
    ),
    check("github_push_intents_source_sha_check", sql`${table.sourceRef} = ${table.intendedSha}`),
    check(
      "github_push_intents_predecessor_sha_check",
      sql`${table.leasePredecessorSha} IS NULL OR ${table.leasePredecessorSha} ~ '^[0-9a-f]{40}$'`,
    ),
    index("github_push_intents_org_id").on(table.orgId),
    index("github_push_intents_org_spec_branch").on(table.orgId, table.specId, table.branch),
    uniqueIndex("github_push_intents_pending_unique")
      .on(table.orgId, table.specId, table.branch)
      .where(sql`${table.status} = 'pending'`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
