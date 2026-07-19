// ds-3 (F2D) — the org-scoped DESIGN-FRAGMENT REGISTRY.
//
// The F2D authoring loop (mirroring the code-fragment `fragments` table) persists
// each validated design fragment here as an immutable, org-owned registry row; the
// selector reads it back to answer "is this (kind, label) already present?". A
// fragment is authored ATOMICALLY as `validated`; a failed post-authoring batch
// compose RETRACTS the row (hard delete) so the org's registry stays free of
// cross-run contamination — the same discipline the code-F2 `fragments` table uses.
//
// TENANCY — `org_id` on every row, `.enableRLS()` (drizzle emits ENABLE + the
// deny-by-default `rls_org_isolation` policy), and the migration hand-appends
// `FORCE ROW LEVEL SECURITY` (mirrors the ds-0 design_system_* tables): a query off
// the scoped client sees ZERO of another tenant's rows even for the table owner.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

const sha256Pattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// The frozen ordered fragment phases (mirrors DESIGN_FRAGMENT_PHASES in
// designArtifactSchemas.ts — kept in lock-step; a fragment with an off-vocab phase
// is rejected at the DB boundary as well as the zod boundary).
const phaseList = sql.raw(
  "('base','primitive-tokens','semantic-tokens','component-tokens','theme-modes'," +
    "'typography-icons-assets','component-primitives','components','patterns-and-templates'," +
    "'motion-and-interaction','platform-binding','catalog-and-scenarios','exporters','postprocessors')",
);

function designOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", { for: "all", using: predicate, withCheck: predicate });
}

export const designFragments = pgTable(
  "design_fragments",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    designSystemId: text("design_system_id"),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    phase: text("phase").notNull(),
    version: text("version").notNull(),
    digest: text("digest").notNull(),
    targetCapabilities: jsonb("target_capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    requires: jsonb("requires")
      .notNull()
      .default(sql`'[]'::jsonb`),
    provides: jsonb("provides")
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: jsonb("depends_on")
      .notNull()
      .default(sql`'[]'::jsonb`),
    conflicts: jsonb("conflicts")
      .notNull()
      .default(sql`'[]'::jsonb`),
    replaces: jsonb("replaces")
      .notNull()
      .default(sql`'[]'::jsonb`),
    personaRefs: jsonb("persona_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    behaviorRefs: jsonb("behavior_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    conformanceSuiteId: text("conformance_suite_id").notNull(),
    // The canonical draft JSON (the fragment body) + the resolved file descriptors.
    body: jsonb("body").notNull(),
    files: jsonb("files")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("validated"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    // The reuse key — one validated fragment per (org, kind, label, version).
    uniqueIndex("design_fragments_org_klv_unique").on(table.orgId, table.kind, table.label, table.version),
    index("design_fragments_org_kind_label").on(table.orgId, table.kind, table.label),
    check("design_fragments_digest_check", sql`${table.digest} ~ ${sha256Pattern}`),
    check("design_fragments_status_check", sql`${table.status} IN ('draft','validated')`),
    check("design_fragments_phase_check", sql`${table.phase} IN ${phaseList}`),
    designOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
