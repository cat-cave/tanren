import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects, specs } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// mq-10 — every autonomous-repair routing decision the merge queue makes for one isolated
// member, oldest → newest. It is BOTH the fixed-point attempt history (the router loads prior
// rows for a spec to detect a proven fixed point) AND the respec lineage (the `respec` rows
// carry the packet hash + prior/next agent route + replacement spec ids — the `respec_routes`
// projection the mergequeue spec names). Append-only operational state; the typed
// `merge.repair.routed` / `merge.member.respec_routed` events remain the sole event path.
export const mergeRepairRoutes = pgTable(
  "merge_repair_routes",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    routeId: text("route_id").notNull(),
    projectId: text("project_id").notNull(),
    sourceSpecId: text("source_spec_id").notNull(),
    groupId: text("group_id").notNull(),
    evaluationId: text("evaluation_id").notNull(),
    // repair_in_place | respec | blocked_needs_attention
    disposition: text("disposition").notNull(),
    // deterministic_policy | needs_product_decision | unknown_fail_closed | transient_infrastructure
    failureClass: text("failure_class").notNull(),
    failureSignature: text("failure_signature").notNull(),
    magnitude: integer("magnitude").notNull(),
    findingIds: text("finding_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reasonCodes: text("reason_codes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // 0 until the first respec; increments per respec of this source spec.
    respecGeneration: integer("respec_generation").notNull().default(0),
    priorAgentRoute: text("prior_agent_route"),
    nextAgentRoute: text("next_agent_route"),
    packetHash: text("packet_hash"),
    replacementSpecIds: text("replacement_spec_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.routeId] }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.sourceSpecId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "merge_repair_routes_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_repair_routes_project_fk",
    }),
    // The history-load key: prior attempts for one spec in creation order.
    index("merge_repair_routes_spec_history").on(table.orgId, table.projectId, table.sourceSpecId, table.createdAt),
    index("merge_repair_routes_org_id").on(table.orgId),
    check(
      "merge_repair_routes_disposition_check",
      sql`${table.disposition} IN ('repair_in_place','respec','blocked_needs_attention')`,
    ),
    // A respec row MUST carry its lineage; a non-respec row MUST NOT.
    check(
      "merge_repair_routes_respec_lineage_check",
      sql`(${table.disposition} = 'respec') = (${table.packetHash} IS NOT NULL AND ${table.priorAgentRoute} IS NOT NULL AND ${table.nextAgentRoute} IS NOT NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
