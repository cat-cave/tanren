import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

/**
 * ds-4 sub-node #3 — the persisted design-render (a11y) verdict the native gate binds.
 *
 * The design-composition producer (`composeProjectWebDesignSystem`) renders the
 * composed system's catalog components browser-free (React SSR + axe), judges them
 * against the project's `accessibilityPosture`, and persists ONE run-level outcome
 * per composed release. The land-time gate (`resolveDesignRenderGate`) reads the
 * latest row for the run's project and fails closed on a `failed_visual` /
 * `inconclusive_infrastructure` outcome. A `not_applicable` outcome (posture "none")
 * never blocks. Org-scoped (deny-by-default RLS), exactly like every tenant table.
 */
export const designRenderLandVerdicts = pgTable(
  "design_render_land_verdicts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    designSystemId: text("design_system_id").notNull(),
    releaseId: text("release_id").notNull(),
    designContractVersion: text("design_contract_version").notNull(),
    accessibilityStandard: text("accessibility_standard").notNull(),
    outcome: text("outcome").notNull(),
    checkpointCount: integer("checkpoint_count").notNull(),
    passedCount: integer("passed_count").notNull(),
    failedCount: integer("failed_count").notNull(),
    inconclusiveCount: integer("inconclusive_count").notNull(),
    excludedCount: integer("excluded_count").notNull(),
    failingScenarioKey: text("failing_scenario_key"),
    failingRuleIds: jsonb("failing_rule_ids").$type<string[]>().notNull(),
    checkpoints: jsonb("checkpoints")
      .$type<{ checkpointId: string; verdict: "passed" | "failed" | "unknown"; failingRuleIds: string[] }[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("design_render_land_verdicts_org_id").on(table.orgId),
    index("design_render_land_verdicts_org_project").on(table.orgId, table.projectId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "design_render_land_verdicts_project_fk",
    }),
    check(
      "design_render_land_verdicts_outcome_check",
      sql`${table.outcome} IN ('passed','failed_visual','inconclusive_infrastructure','not_applicable')`,
    ),
    check("design_render_land_verdicts_checkpoint_count_check", sql`${table.checkpointCount} >= 0`),
    check("design_render_land_verdicts_passed_count_check", sql`${table.passedCount} >= 0`),
    check("design_render_land_verdicts_failed_count_check", sql`${table.failedCount} >= 0`),
    check("design_render_land_verdicts_inconclusive_count_check", sql`${table.inconclusiveCount} >= 0`),
    check("design_render_land_verdicts_excluded_count_check", sql`${table.excludedCount} >= 0`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
