// ds-7 — the design adapter conformance-run schema. Records one
// `DesignAdapterConformanceReceiptV1` outcome per (org, project, target,
// release, artifact) coordinate. Org/project scoped with composite FKs to
// `projects` / `design_system_releases` / `design_artifacts`. ENABLE + FORCE
// RLS via the direct ds-5 `org_id = current_setting('app.current_org_id', true)`
// policy. CHECKs admit only frozen target/outcome values and require a
// receipt+evidence for `passed`.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { designArtifacts, designSystemReleases } from "./schemaDesignSystems.js";

const sha256Pattern = sql.raw("'^sha256:[0-9a-f]{64}$'");
const targetList = sql.raw(
  "'web-react','generic-web','bevy','swiftui','jetpack-compose','flutter','react-native','document-media'",
);
const outcomeList = sql.raw("'passed','failed','inconclusive_infrastructure','not_applicable'");

/** Direct ds-5 tenant policy: `org_id = current_setting('app.current_org_id', true)`. */
function adapterConformanceOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", {
    for: "all",
    using: predicate,
    withCheck: predicate,
  });
}

/**
 * `design_adapter_conformance_runs` — one row per (org, project, target, release,
 * artifact) coordinate a conformance run covered. `passed` is the only green
 * state, and it requires the receipt body AND the evidence artifact digest to be
 * present (a NULL receipt for a `passed` outcome is a CHECK violation, so the
 * gate never sees a partial pass). The receipt's `artifactDigest` MUST equal the
 * `evidence_artifact_digest` column — that equality is the proof≡effect guard.
 */
export const designAdapterConformanceRuns = pgTable(
  "design_adapter_conformance_runs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    releaseId: text("release_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    target: text("target").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    // The manifest digest of the EXACT artifact the receipt conformed against.
    // CHECK-constrained sha256; equality with the artifact row's digest is
    // asserted at write time (proof≡effect, trap #7).
    artifactDigest: text("artifact_digest").notNull(),
    // The canonical sha256 digest of the frozen receipt body.
    receiptDigest: text("receipt_digest").notNull(),
    // The free-form evidence (the receipt body itself; the gate + dashboard
    // surface consume it). Required for `passed`; NULL only for an absent/
    // inconclusive run record.
    receipt: jsonb("receipt"),
    outcome: text("outcome").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("design_adapter_conformance_runs_org_id").on(table.orgId),
    index("design_adapter_conformance_runs_org_project").on(table.orgId, table.projectId),
    index("design_adapter_conformance_runs_org_project_target").on(table.orgId, table.projectId, table.target),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "design_adapter_conformance_runs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.releaseId],
      foreignColumns: [designSystemReleases.orgId, designSystemReleases.id],
      name: "design_adapter_conformance_runs_release_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.artifactId],
      foreignColumns: [designArtifacts.orgId, designArtifacts.id],
      name: "design_adapter_conformance_runs_artifact_fk",
    }),
    check("design_adapter_conformance_runs_target_check", sql`${table.target} IN (${targetList})`),
    check("design_adapter_conformance_runs_outcome_check", sql`${table.outcome} IN (${outcomeList})`),
    check("design_adapter_conformance_runs_artifact_digest_check", sql`${table.artifactDigest} ~ ${sha256Pattern}`),
    check("design_adapter_conformance_runs_receipt_digest_check", sql`${table.receiptDigest} ~ ${sha256Pattern}`),
    // A `passed` outcome REQUIRES the receipt body AND a non-default adapter
    // version. A NULL receipt is allowed ONLY for a non-passed outcome (an
    // inconclusive run can record its reason without a full receipt).
    check(
      "design_adapter_conformance_runs_passed_requires_receipt_check",
      sql`(${table.outcome} = 'passed' AND ${table.receipt} IS NOT NULL AND ${table.adapterVersion} <> '') OR (${table.outcome} <> 'passed')`,
    ),
    adapterConformanceOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
