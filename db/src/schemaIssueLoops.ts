import { sql } from "drizzle-orm";
import {
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
import { organizations, projects } from "./schemaCore.js";
import { inboxSources } from "./schemaInbox.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

// bh-1 — the durable IssueLoop aggregate (an issue's lifecycle root) plus the
// immutable, append-only source findings it projects, and the causal edges
// between loops. This is the foundation the resolution DAG (bh-6) and all of
// bh-2..14 build on. Every table is org-scoped with deny-by-default RLS and
// composite tenant-lineage FKs so that even a system-credentialed application
// bug cannot forge a cross-org relationship.
//
// Forward-linked pointers (current_contract_id → symptom_contracts in bh-4,
// current_attempt_id → remediation_attempts in bh-13) are intentionally kept as
// nullable, unconstrained columns here; their FKs land with the tables that own
// them. That is a deliberate foundation seam, not a fabricated reference.

/**
 * `issue_loops` — one durable causal history root for a source issue. Inbox
 * candidates become a projection onto this aggregate, not the source of truth.
 * `row_version` is app-managed optimistic concurrency (never xmin).
 */
export const issueLoops = pgTable(
  "issue_loops",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    sourceId: text("source_id").notNull(),
    externalKey: text("external_key").notNull(),
    generation: integer("generation").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").notNull(),
    state: text("state").notNull().default("open"),
    // Latest observed provider revision for the aggregate (nullable until first observed).
    sourceRevisionId: text("source_revision_id"),
    // Forward seams — FKs added by bh-4 / bh-13 when those tables exist.
    currentContractId: text("current_contract_id"),
    currentAttemptId: text("current_attempt_id"),
    resolutionPolicy: text("resolution_policy").notNull().default("active_causal"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "issue_loops_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.sourceId],
      foreignColumns: [inboxSources.orgId, inboxSources.id],
      name: "issue_loops_source_fk",
    }),
    uniqueIndex("issue_loops_org_project_id_unique").on(table.orgId, table.projectId, table.id),
    uniqueIndex("issue_loops_source_external_generation_unique").on(
      table.orgId,
      table.sourceId,
      table.externalKey,
      table.generation,
    ),
    index("issue_loops_org_id").on(table.orgId),
    index("issue_loops_org_project").on(table.orgId, table.projectId),
    index("issue_loops_org_project_state").on(table.orgId, table.projectId, table.state),
    check("issue_loops_generation_check", sql`${table.generation} >= 1`),
    check("issue_loops_row_version_check", sql`${table.rowVersion} >= 1`),
    check("issue_loops_severity_check", sql`${table.severity} IN ('critical','high','medium','low','info')`),
    check(
      "issue_loops_state_check",
      sql`${table.state} IN ('open','awaiting_reproduction','reproduced','triaged','remediating','verifying','verified_source_sync_pending','verified_closed','externally_closed_unverified','needs_attention','wont_fix')`,
    ),
    check(
      "issue_loops_resolution_policy_check",
      sql`${table.resolutionPolicy} IN ('active_causal','active_plus_soak','observational','attested')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/**
 * `source_findings` — immutable, append-only normalized source observations. A
 * new provider revision is a NEW row; prior revisions are never overwritten.
 * Mutation/deletion is refused at the database by `enforce_source_findings_immutable`
 * (see migration 0049), so the append-only invariant holds even against a
 * system-credentialed client.
 */
export const sourceFindings = pgTable(
  "source_findings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    sourceId: text("source_id").notNull(),
    providerObjectId: text("provider_object_id").notNull(),
    providerRevision: text("provider_revision").notNull(),
    deliveryId: text("delivery_id"),
    status: text("status").notNull(),
    release: text("release"),
    environment: text("environment"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    context: jsonb("context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    fingerprint: text("fingerprint").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    rawArtifactRef: text("raw_artifact_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "source_findings_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.projectId, issueLoops.id],
      name: "source_findings_issue_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.sourceId],
      foreignColumns: [inboxSources.orgId, inboxSources.id],
      name: "source_findings_source_fk",
    }),
    uniqueIndex("source_findings_provider_revision_unique").on(
      table.orgId,
      table.sourceId,
      table.providerObjectId,
      table.providerRevision,
    ),
    index("source_findings_org_id").on(table.orgId),
    index("source_findings_org_loop_observed").on(table.orgId, table.issueLoopId, table.observedAt),
    check(
      "source_findings_status_check",
      sql`${table.status} IN ('open','closed','reopened','edited','deleted','unknown')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/**
 * `issue_loop_edges` — causal relationships between loops: `duplicate_of`,
 * `supersedes`, `regression_of`, `caused_by`, `split_from`. Both endpoints are
 * pinned to the same project via composite tenant-lineage FKs.
 */
export const issueLoopEdges = pgTable(
  "issue_loop_edges",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    issueLoopId: text("issue_loop_id").notNull(),
    relatedIssueLoopId: text("related_issue_loop_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.projectId, table.issueLoopId, table.relatedIssueLoopId, table.relation],
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "issue_loop_edges_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.projectId, issueLoops.id],
      name: "issue_loop_edges_loop_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.relatedIssueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.projectId, issueLoops.id],
      name: "issue_loop_edges_related_fk",
    }),
    index("issue_loop_edges_org_id").on(table.orgId),
    index("issue_loop_edges_org_related").on(table.orgId, table.projectId, table.relatedIssueLoopId),
    check(
      "issue_loop_edges_relation_check",
      sql`${table.relation} IN ('duplicate_of','supersedes','regression_of','caused_by','split_from')`,
    ),
    check("issue_loop_edges_no_self_check", sql`${table.issueLoopId} <> ${table.relatedIssueLoopId}`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
