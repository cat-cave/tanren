// Tanren-native design subsystem (WS-D1) — the `design_contracts` table.
//
// The durable, first-class, VERSIONED, org-scoped `DesignContract` entity: the
// design-intent contract the build later injects into the writer (WS-D2) and a
// domain-aware oracle verifies fidelity against (WS-D4). It supersedes the
// decorative 80-char `designDna` interview hint (which never reached the writer).
// docs/roadmap/native-design-subsystem.md. Split into its own schema file
// (re-exported into the single `schema.*` namespace at the bottom of schema.ts)
// to respect the file-line-max architecture rule, mirroring schemaTemplates.ts.
//
// SCOPING — org-scoped, project-anchored. Every contract is OWNED by an org
// (`org_id`) and tied to a project (`project_id`). Under deny-by-default RLS an
// org-scoped client sees only its own contracts; an off-scope client sees ZERO
// rows (see the design_contracts RLS block in the migration).
//
// VERSIONED — a design CHANGE mints the NEXT version for the project rather than
// overwriting (the never-discard posture; what lets a later workstream
// re-propagate a design change without discarding history). `(project_id,
// version)` is unique; the store computes the next version in the insert.
//
// PROJECT-SCOPED (H2 BLOCKING — unify): the contract describes PRODUCT identity
// (behaviors, personas, dimensions) which is shared across ALL spec types in the
// same project — scaffold specs need product identity for README naming, feature
// specs need it for behavior grading, and there is exactly ONE product-level
// contract per project. Migration 0026 briefly keyed the head on `(project_id,
// mode, version)` to give per-writer-prompt-mode heads, but no code path wrote a
// row at `specialize_seed` (only `persistDesignContract` at derive wrote, at the
// default `from_scratch`), so the mode-keyed head silently no-op'd for scaffold /
// build / deploy specs (WS-D2 writer got no design block; WS-D4 oracle returned
// `{ hasContract: false }`). Migration 0028 collapses this back to a single
// per-project head. The writer prompt's mode-awareness remains where it belongs
// (`subtaskWriterPrompt.ts` + `designOraclePrompt.ts` tail blocks — the v64 fix);
// this table just carries the shared product contract.
//
// DOMAIN-GENERAL — the `contract` jsonb is the parsed `DesignContractV1`
// (designContract.ts): a typed core + a domain-ADAPTIVE dimension set whose shape
// the project/domain declares. NO web design-system is encoded in the table.
// `domain` is mirrored out of the contract into its own column (a descriptive
// label Tanren never branches on) for filtering/observability without parsing the
// jsonb — the same denormalization the templates table does with `channel`.
//
// NO column default on `contract`: a `DesignContractV1` has no empty-but-valid
// shape (version/domain/identity/intent are all required), so a bare `{}` is NOT
// a valid contract. `DesignContractStore` re-parses every row on READ, so a
// `{}`-defaulted insert would poison reads with a loud parse throw — the column
// is NOT-NULL with no default, rejecting a "no valid contract" insert at write.

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

export const designContracts = pgTable(
  "design_contracts",
  {
    id: text("id").primaryKey(),
    // The owning org — the tenant key the RLS policy isolates on.
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The project this contract belongs to. A project's design contract is
    // versioned; `getLatest` reads the head the build builds against.
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    // The monotonic 1-based version. A design change mints the next version (the
    // store computes max+1 in the insert); `(project_id, version)` is unique.
    version: integer("version").notNull(),
    // The descriptive design DOMAIN label ("saas-web", "mobile-game",
    // "novel-translation"), mirrored from the contract jsonb. Human-readable +
    // domain-derived — Tanren NEVER branches on it; it is the signal the design
    // agent/oracle use to author/verify, not a Tanren-side switch.
    domain: text("domain").notNull(),
    // The parsed `DesignContractV1` (designContract.ts), persisted verbatim. The
    // single source of truth; `domain` above is a denormalized projection.
    contract: jsonb("contract").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("design_contracts_version_check", sql`${table.version} >= 1`),
    uniqueIndex("design_contracts_project_version_unique").on(table.projectId, table.version),
    index("design_contracts_org_id").on(table.orgId),
    index("design_contracts_project_id").on(table.projectId),
    index("design_contracts_domain").on(table.domain),
  ],
);
