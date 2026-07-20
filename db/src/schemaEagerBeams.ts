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
import { integrationNodes } from "./schemaIntegrationNodes.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { organizations, projects, runs, specs } from "./schemaCore.js";
import { casArtifactsReference } from "./schemaSpineReferences.js";

// mq-8's durable view of a speculative build. It records an exact plan/digest and
// never duplicates queue state or merge authority.
export const mergeEagerBeams = pgTable(
  "merge_eager_beams",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    frontierRunId: text("frontier_run_id").notNull(),
    frontierSpecId: text("frontier_spec_id").notNull(),
    planDigest: text("plan_digest"),
    integrationNodeId: text("integration_node_id"),
    rank: integer("rank").notNull(),
    generation: integer("generation").notNull().default(1),
    state: text("state").notNull(),
    staleReason: text("stale_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_eager_beams_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.frontierRunId],
      foreignColumns: [runs.orgId, runs.runId],
      name: "merge_eager_beams_frontier_run_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.frontierSpecId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "merge_eager_beams_frontier_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.planDigest],
      foreignColumns: [casArtifactsReference.orgId, casArtifactsReference.digest],
      name: "merge_eager_beams_plan_cas_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.integrationNodeId],
      foreignColumns: [integrationNodes.orgId, integrationNodes.nodeId],
      name: "merge_eager_beams_integration_node_fk",
    }),
    uniqueIndex("merge_eager_beams_org_plan_digest_unique").on(table.orgId, table.planDigest),
    uniqueIndex("merge_eager_beams_org_frontier_held_unique")
      .on(table.orgId, table.frontierRunId)
      .where(sql`${table.planDigest} IS NULL`),
    index("merge_eager_beams_org_project").on(table.orgId, table.projectId),
    check("merge_eager_beams_rank_check", sql`${table.rank} >= 1`),
    check("merge_eager_beams_generation_check", sql`${table.generation} >= 1`),
    check("merge_eager_beams_state_check", sql`${table.state} IN ('building','ready','stale','held')`),
    check(
      "merge_eager_beams_complete_plan_check",
      sql`(${table.state} IN ('held') AND ${table.planDigest} IS NULL AND ${table.integrationNodeId} IS NULL) OR (${table.planDigest} IS NOT NULL AND ${table.integrationNodeId} IS NOT NULL)`,
    ),
    check(
      "merge_eager_beams_stale_reason_check",
      sql`(${table.state} IN ('stale','held') AND ${table.staleReason} IS NOT NULL) OR (${table.state} IN ('building','ready') AND ${table.staleReason} IS NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
