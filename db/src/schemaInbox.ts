// P3-0022 candidate inbox: the intake mouth of the loop.
//
// Two tables, split from schema.ts to respect the file-line-max-500
// architecture rule (re-exported into the single `schema.*` namespace at the
// bottom of schema.ts so the migration generator + consumers see one space):
//
//   inbox_sources  — CONFIGURABLE source connectors (GitHub Issues now;
//                    Linear/Sentry/manual/scheduled-audits as the matrix). A
//                    source carries a connector `kind`, a free-form `config`
//                    JSONB (repo/labels/query/etc), an `on` toggle, and an
//                    `auto` flag. System sources (auto=true, e.g. scheduled
//                    audits) auto-route their candidates to accepted with no
//                    manual triage; external issues get the full Forge triage.
//
//   candidates     — one ingested item from a source, with its Forge TRIAGE
//                    read-out (dedupe / match-to-spec-or-milestone / proposed
//                    DAG placement / verdict) persisted as JSONB, plus a
//                    lifecycle `status`. `external_id` + source uniqueness keeps
//                    a connector idempotent (re-polling the same issue updates,
//                    never duplicates). When a candidate is accepted into the
//                    discovery flow the created spec-id lands on `resolved_spec_id`.
//
// The triage itself runs over the same injectable answerer seam as P3-0010 /
// P3-0014 (engine code in services/orchestrator/src/engine/forge/inbox/**), so
// the LLM/Forge call is mockable and nothing here couples to a provider.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, specs } from "./schemaCore.js";

// Connector kinds — mirrors the hi-fi `INBOX_SOURCES` glyph keys. `system`
// sources auto-route; the rest feed candidates that wait for an operator call.
const SOURCE_KINDS = ["issues", "errors", "system", "manual", "scheduled_audit"] as const;

export const inboxSources = pgTable(
  "inbox_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // A source may be org-wide (e.g. a manual paste inbox) or pinned to one
    // project (e.g. a repo's GitHub Issues feed). Null = org-wide.
    projectId: text("project_id").references(() => projects.projectId),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    detail: text("detail").notNull().default(""),
    // Connector-specific config (repo, labels, linear team, sentry query, …).
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    // `enabled` toggles polling/ingest; `autoRoute` marks a system source whose
    // findings skip manual triage (verdict auto-routable → accepted).
    enabled: text("enabled").notNull().default("true"),
    autoRoute: text("auto_route").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "inbox_sources_kind_check",
      sql`${table.kind} IN ('issues','errors','system','manual','scheduled_audit')`
    ),
    check("inbox_sources_enabled_check", sql`${table.enabled} IN ('true','false')`),
    check("inbox_sources_auto_route_check", sql`${table.autoRoute} IN ('true','false')`),
    index("inbox_sources_org_id").on(table.orgId),
    index("inbox_sources_project_id").on(table.projectId)
  ]
);

// Candidate lifecycle: `triaged` is the resting state for external candidates
// awaiting an operator call; the four resolutions mirror the hi-fi actions
// (accept→discovery / fold-into-live-run / dismiss / close-as-dup), and
// `auto_routed` is the terminal state for a system source's auto-promoted find.
const CANDIDATE_STATUSES = [
  "new",
  "triaged",
  "auto_routed",
  "accepted",
  "folded",
  "dismissed",
  "closed_duplicate"
] as const;

export const candidates = pgTable(
  "candidates",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => inboxSources.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.projectId),
    // The connector's own id for this item (issue number, sentry group, audit
    // finding key, manual nonce) — unique per source so re-polling is idempotent.
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    severity: text("severity").notNull().default("info"),
    status: text("status").notNull().default("new"),
    // The Forge triage read-out: { dedupe, match, placement, verdict, ... }.
    triage: jsonb("triage").notNull().default(sql`'{}'::jsonb`),
    // Set when accept→discovery created a spec, so the inbox links to the node.
    resolvedSpecId: text("resolved_spec_id").references(() => specs.specId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "candidates_severity_check",
      sql`${table.severity} IN ('info','warn','fail')`
    ),
    check(
      "candidates_status_check",
      sql`${table.status} IN ('new','triaged','auto_routed','accepted','folded','dismissed','closed_duplicate')`
    ),
    uniqueIndex("candidates_source_external_unique").on(table.sourceId, table.externalId),
    index("candidates_org_id").on(table.orgId),
    index("candidates_project_id").on(table.projectId),
    index("candidates_status").on(table.status)
  ]
);

// Runtime literal lists, exported for the orchestrator engine to validate
// against without re-declaring the union.
export const inboxSourceKinds = SOURCE_KINDS;
export const candidateStatuses = CANDIDATE_STATUSES;
