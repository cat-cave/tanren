// Entity-anchored issue CLAIMS — the Tanren-native defect ledger
// (docs/roadmap/entity-analysis-layer.md §3.3, the surviving lodestar thread).
//
// §2.3 made issue-triage a ONE-SHOT "is this issue's target entity still present?"
// check using `sem`'s STRUCTURAL-HASH entity identity. §3.3 makes that decision
// DURABLE: an issue/finding is anchored to a `entity_claims` row keyed on the
// entity's structural-hash identity (NOT a file:line, which a refactor orphans).
// A Claim anchored to an entity SELF-RESOLVES when `sem` reports the entity
// removed/refactored, and SURVIVES the refactors that would strand a line-anchored
// claim — so the triage agent's one-shot verdict becomes a standing, self-
// validating Claim in a defect ledger.
//
// SCOPING — org-scoped, deny-by-default RLS (3a direct-org_id, like candidates /
// post_merge_issue_claims). A query off the org-scoped client sees ZERO rows; the
// hand-written RLS in the migration mirrors the baseline 3a direct-org_id policy
// with NO cross-org exception (a Claim is private defect-ledger state). NO
// empty-on-missing-org fallback (the fail-closed RLS doctrine).
//
// GENERALITY (the oracle-taxonomy generality mechanism): the core model is NOT
// code-specific. `entity_id` is whatever first-class unit the producer extracts
// (a function/class/type for code; a chapter/stanza for a non-code project) keyed
// by its STRUCTURAL identity; `entity_kind` is a free-form producer label
// (`function`/`class`/`type`/…), never an enum baked to a language. A Claim is
// "a durable assertion that a defect lives in THIS entity", whatever the stack.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { candidates } from "./schemaInbox.js";

export const entityClaims = pgTable(
  "entity_claims",
  {
    id: text("id").primaryKey(),
    // The tenant root (RLS 3a direct-org_id). A query off the org-scoped client
    // sees ZERO rows; fail-closed, no empty-on-missing-org fallback.
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The project the Claim's entity lives in. A Claim is always project-scoped
    // (the entity is in a project's repo); the self-validation oracle re-checks
    // the entity against THAT project's current code on the runner.
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    // The candidate (issue/finding) this Claim was anchored FROM during triage —
    // the provenance link back to the inbox. The triage one-shot becomes this
    // durable Claim; consulting the ledger by candidate keeps a self-resolved
    // Claim from being re-triaged as live.
    candidateId: text("candidate_id").references(() => candidates.id),
    // ── The entity anchor (the structural-hash IDENTITY, not a file:line) ──────
    // `entity_id` is the durable identity `sem` assigns the entity (its structural
    // hash / a path-qualified stable key) — it SURVIVES a rename/move, which is the
    // whole point: a line-anchored claim is orphaned by the refactor, this is not.
    entityId: text("entity_id").notNull(),
    // The producer's label for the entity kind (`function`/`class`/`type`/…).
    // Free-form on purpose — never an enum baked to a language (generality).
    entityKind: text("entity_kind").notNull().default("unknown"),
    // The entity's human-readable name AT ANCHOR TIME (e.g. `parseUserToken`) — a
    // display aid + the fallback locator when no entity producer is available. NOT
    // the identity (a rename changes this but not `entity_id`).
    entityName: text("entity_name").notNull().default(""),
    // The file the entity lived in AT ANCHOR TIME — a locator hint for the
    // producer + the raw-grep fallback, NOT part of the identity.
    entityPath: text("entity_path").notNull().default(""),
    // ── The Claim lifecycle ───────────────────────────────────────────────────
    //   open          — the defect stands; the entity is still present.
    //   self_resolved — the self-validation oracle saw POSITIVE evidence (`sem`
    //                   reports the entity removed/refactored) that the entity is
    //                   gone; the defect can no longer live there. The DURABLE
    //                   form of §2.3's stale-issue resolution.
    //   agent_resolved — an agent (triage / a fix run) resolved the defect while
    //                   the entity still exists (e.g. the bug was fixed in place).
    //   dismissed     — an operator/agent judged the Claim invalid.
    status: text("status").notNull().default("open"),
    // The DECIDABILITY tier of the LAST self-validation (§3.3 / lodestar decidability
    // tiers): `decidable` = the oracle reached a confident verdict from positive
    // evidence; `needs_agent` = the evidence was ambiguous (entity present-but-
    // modified, or a partial producer signal) and an agent must judge; `unchecked`
    // = never self-validated yet (the anchor-time default). NEVER auto-resolves on
    // absent evidence — absence keeps the Claim `open`/`unchecked`.
    decidability: text("decidability").notNull().default("unchecked"),
    // The structured read-out of the last self-validation (the oracle's
    // EntityProbeOutcome + rationale), persisted verbatim for observability. Empty
    // until the first re-check. NOT secret-bearing (entity identity + a rationale).
    lastValidation: jsonb("last_validation")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when status leaves `open` (self_resolved/agent_resolved/dismissed).
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    check("entity_claims_status_check", sql`${table.status} IN ('open','self_resolved','agent_resolved','dismissed')`),
    check("entity_claims_decidability_check", sql`${table.decidability} IN ('decidable','needs_agent','unchecked')`),
    // Idempotency: at most one Claim per (project, entity identity, candidate) — a
    // re-triage of the same candidate against the same entity UPDATES, never
    // duplicates. `candidate_id` is part of the key so two distinct issues against
    // the same entity remain distinct Claims.
    uniqueIndex("entity_claims_project_entity_candidate_unique").on(table.projectId, table.entityId, table.candidateId),
    index("entity_claims_org_id").on(table.orgId),
    index("entity_claims_org_project").on(table.orgId, table.projectId),
    // The self-validation sweep's hot read: open Claims for a project, oldest-
    // validated first (re-check the most stale anchors first).
    index("entity_claims_project_status").on(table.projectId, table.status),
    // Consult-by-candidate (triage checks "did this candidate's Claim self-resolve?").
    index("entity_claims_candidate_id").on(table.candidateId),
  ],
);
