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

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// Wave-6 rv-8 reservation: provider observations are immutable evidence. The
// separate observer watermark is intentionally mutable so polling can advance.
export const behaviorEffectObservations = pgTable(
  "behavior_effect_observations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    observationId: text("observation_id").notNull(),
    triggerIdHash: text("trigger_id_hash"),
    observer: text("observer").notNull(),
    provider: text("provider").notNull(),
    providerObjectHash: text("provider_object_hash"),
    cursor: text("cursor"),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    latencyMs: integer("latency_ms"),
    classification: text("classification").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.observationId] }),
    uniqueIndex("behavior_effect_observations_org_project_observation_id_unique").on(
      table.orgId,
      table.projectId,
      table.observationId,
    ),
    index("behavior_effect_observations_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "behavior_effect_observations_project_fk",
    }),
    check("behavior_effect_observations_trigger_id_hash_check", sql`${table.triggerIdHash} ~ ${digestPattern}`),
    check(
      "behavior_effect_observations_provider_object_hash_check",
      sql`${table.providerObjectHash} ~ ${digestPattern}`,
    ),
    check(
      "behavior_effect_observations_classification_check",
      sql`${table.classification} IN ('ok','missing','duplicate')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const effectObserverWatermarks = pgTable(
  "effect_observer_watermarks",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    observer: text("observer").notNull(),
    watermark: text("watermark").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.observer] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "effect_observer_watermarks_project_fk",
    }),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
