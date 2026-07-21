import { sql } from "drizzle-orm";
import {
  boolean,
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
import { mergeQueue, organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

export const mergeQueuePolicies = pgTable(
  "merge_queue_policies",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    targetBranch: text("target_branch").notNull(),
    version: integer("version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    body: jsonb("body").notNull(),
    compiledHash: text("compiled_hash").notNull(),
    active: boolean("active").notNull().default(true),
    supersedes: text("supersedes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_policies_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.supersedes],
      foreignColumns: [table.orgId, table.id],
      name: "merge_queue_policies_supersedes_fk",
    }),
    check("merge_queue_policies_schema_version_check", sql`${table.schemaVersion} = 'queue_policy.v1'`),
    uniqueIndex("merge_queue_policies_org_version_unique").on(table.orgId, table.projectId, table.version),
    uniqueIndex("merge_queue_policies_active_unique")
      .on(table.orgId, table.projectId)
      .where(sql`${table.active} = true`),
    index("merge_queue_policies_org_project").on(table.orgId, table.projectId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const mergeQueueCommands = pgTable(
  "merge_queue_commands",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    policyId: text("policy_id").notNull(),
    actorId: text("actor_id").notNull(),
    command: text("command").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    scopeTargetBranch: text("scope_target_branch"),
    scopeQueueId: text("scope_queue_id"),
    payload: jsonb("payload").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_commands_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.policyId],
      foreignColumns: [mergeQueuePolicies.orgId, mergeQueuePolicies.id],
      name: "merge_queue_commands_policy_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.scopeQueueId],
      foreignColumns: [mergeQueue.orgId, mergeQueue.queueId],
      name: "merge_queue_commands_queue_fk",
    }),
    check(
      "merge_queue_commands_command_check",
      sql`${table.command} IN ('queue','requeue','dequeue','refresh','boost','clear-boost','pause','resume','freeze','unfreeze','drain')`,
    ),
    uniqueIndex("merge_queue_commands_idempotency_unique").on(table.orgId, table.projectId, table.idempotencyKey),
    index("merge_queue_commands_org_project_created").on(table.orgId, table.projectId, table.createdAt),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const mergeQueueWindows = pgTable(
  "merge_queue_windows",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    policyId: text("policy_id").notNull(),
    projectId: text("project_id").notNull(),
    targetBranch: text("target_branch"),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    intervals: jsonb("intervals").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.policyId],
      foreignColumns: [mergeQueuePolicies.orgId, mergeQueuePolicies.id],
      name: "merge_queue_windows_policy_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_windows_project_fk",
    }),
    check("merge_queue_windows_kind_check", sql`${table.kind} IN ('allow','blackout')`),
    uniqueIndex("merge_queue_windows_policy_name_unique").on(table.orgId, table.policyId, table.name),
    index("merge_queue_windows_org_project").on(table.orgId, table.projectId),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
