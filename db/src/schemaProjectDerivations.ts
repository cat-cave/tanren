import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

/** Resumable greenfield/interview derivation anchor — forced RLS. */
export const projectDerivations = pgTable(
  "project_derivations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    idempotencyFingerprint: text("idempotency_fingerprint").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull().default("pending"),
    sanitizedInput: jsonb("sanitized_input")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sanitizedError: jsonb("sanitized_error"),
    templateReceipt: jsonb("template_receipt"),
    resultReceipt: jsonb("result_receipt"),
    ownershipReceipt: jsonb("ownership_receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "project_derivations_project_fk",
    }),
    uniqueIndex("project_derivations_idempotency_unique").on(table.orgId, table.idempotencyFingerprint),
    uniqueIndex("project_derivations_active_project_unique")
      .on(table.orgId, table.projectId)
      .where(sql`status IN ('pending','in_progress')`),
    index("project_derivations_org_id").on(table.orgId),
    index("project_derivations_org_project").on(table.orgId, table.projectId, table.status),
    check(
      "project_derivations_phase_check",
      sql`${table.phase} IN ('shell','template','graph','activate','compensate')`,
    ),
    check(
      "project_derivations_status_check",
      sql`${table.status} IN ('pending','in_progress','succeeded','failed','compensated')`,
    ),
    check("project_derivations_fingerprint_check", sql`${table.idempotencyFingerprint} ~ ${digestPattern}`),
    check(
      "project_derivations_completed_check",
      sql`(${table.status} IN ('succeeded','failed','compensated') AND ${table.completedAt} IS NOT NULL) OR (${table.status} IN ('pending','in_progress') AND ${table.completedAt} IS NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
