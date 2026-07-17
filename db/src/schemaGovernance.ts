import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

/** Drizzle-owned deny-by-default tenant policy for the governance tables. */
function governanceOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", {
    for: "all",
    using: predicate,
    withCheck: predicate,
  });
}

// gv-7 — immutable governance policy revisions + the deterministic compiler.
//
// An APPEND-ONLY, org-scoped ledger of compiled policy revisions. Each row is one
// immutable revision of a project's governance policy: the operator-supplied
// `source_document`, the deterministic compiler's `compiled_ast`, and the content
// `policy_hash` the MergeAuthority / review / deployment proof keys bind to.
// Activation is a binding change (a later node); a revision is NEVER mutated —
// the migration installs a BEFORE UPDATE/DELETE guard trigger to prove that at
// the database. Lineage is an immutable self-FK chain (`parent_revision_id`), so
// a rollback is a NEW revision pointing at prior content, never an in-place edit.
//
// Every revision carries a direct, indexed `org_id` and a composite same-org FK to
// its project, with forced deny-by-default RLS (mirrors the 0043 integration
// lifecycle style exactly).
export const governancePolicyRevisions = pgTable(
  "governance_policy_revisions",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    // Monotonic revision sequence per (org, project) policy.
    revisionNumber: integer("revision_number").notNull(),
    // The policy DOCUMENT schema version — a separate concept from the revision
    // sequence (a schema upgrade does not renumber a project's revisions).
    schemaVersion: integer("schema_version").notNull(),
    // Operator-supplied declarative policy document (the YAML/JSON source).
    sourceDocument: jsonb("source_document").notNull(),
    // The deterministic compiler's effective rule AST (+ source map / required
    // principals / required evidence / contradiction witnesses).
    compiledAst: jsonb("compiled_ast").notNull(),
    // Content digest of the compiled effective policy — the proof-key identity.
    policyHash: text("policy_hash").notNull(),
    // Immutable lineage: the revision this one supersedes (NULL for the first).
    parentRevisionId: text("parent_revision_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "governance_policy_revisions_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.parentRevisionId],
      foreignColumns: [table.orgId, table.id],
      name: "governance_policy_revisions_parent_fk",
    }),
    uniqueIndex("governance_policy_revisions_project_revision_unique").on(
      table.orgId,
      table.projectId,
      table.revisionNumber,
    ),
    index("governance_policy_revisions_org_id").on(table.orgId),
    index("governance_policy_revisions_org_project_hash").on(table.orgId, table.projectId, table.policyHash),
    check("governance_policy_revisions_revision_number_check", sql`${table.revisionNumber} >= 1`),
    check("governance_policy_revisions_schema_version_check", sql`${table.schemaVersion} >= 1`),
    check("governance_policy_revisions_policy_hash_check", sql`${table.policyHash} ~ ${digestPattern}`),
    check(
      "governance_policy_revisions_no_self_parent_check",
      sql`${table.parentRevisionId} IS NULL OR ${table.parentRevisionId} <> ${table.id}`,
    ),
    governanceOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
