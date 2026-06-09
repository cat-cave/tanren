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
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects, specs } from "./schemaCore.js";

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
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // `enabled` toggles polling/ingest; `autoRoute` marks a system source whose
    // findings skip manual triage (verdict auto-routable → accepted).
    enabled: text("enabled").notNull().default("true"),
    autoRoute: text("auto_route").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("inbox_sources_kind_check", sql`${table.kind} IN ('issues','errors','system','manual','scheduled_audit')`),
    check("inbox_sources_enabled_check", sql`${table.enabled} IN ('true','false')`),
    check("inbox_sources_auto_route_check", sql`${table.autoRoute} IN ('true','false')`),
    index("inbox_sources_org_id").on(table.orgId),
    index("inbox_sources_project_id").on(table.projectId),
    // P-INT-2 onboarding-provisioner idempotency backstop: at most ONE
    // provisioner-managed source per (org, project, kind). PARTIAL — scoped to the
    // `managedBy` marker the provisioning engine writes — so operator-created
    // sources (which may legitimately repeat a kind per project) and audit-system
    // sources stay unconstrained; only re-onboards dedupe.
    uniqueIndex("inbox_sources_provisioned_unique")
      .on(table.orgId, table.projectId, table.kind)
      .where(sql`(${table.config}->>'managedBy') = 'integration-provisioner'`),
  ],
);

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
    triage: jsonb("triage")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Set when accept→discovery created a spec, so the inbox links to the node.
    resolvedSpecId: text("resolved_spec_id").references(() => specs.specId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("candidates_severity_check", sql`${table.severity} IN ('info','warn','fail')`),
    check(
      "candidates_status_check",
      sql`${table.status} IN ('new','triaged','auto_routed','accepted','folded','dismissed','closed_duplicate')`,
    ),
    uniqueIndex("candidates_source_external_unique").on(table.sourceId, table.externalId),
    index("candidates_org_id").on(table.orgId),
    index("candidates_project_id").on(table.projectId),
    index("candidates_status").on(table.status),
  ],
);

// §3.6 issue-loop hardening: the DURABLE raw-webhook landing table. The webhook
// receiver PERSISTS the verified delivery here and returns 202 FAST (inside
// GitHub's 10s window); a background processor then does the allocation/triage/
// routing OUT of band. This makes intake never-silently-lost: a processing
// failure leaves the row `failed` (with the captured error + an attempt count),
// and the stuck-candidate sweeper RE-DRIVES `received`/`failed` rows on its
// interval — idempotently, since the downstream `intakeItem` is keyed on
// (source, externalId). A row that exhausts its attempt budget is parked
// `dead_lettered` (a loud, human-visible terminal — never an infinite re-drive).
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => inboxSources.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The provider event name (`issues`) — so the processor dispatches the right
    // mapper, and a sweeper can scope to a kind.
    eventType: text("event_type").notNull(),
    // GitHub's `x-github-delivery` id when present — diagnostics + dedupe aid.
    deliveryId: text("delivery_id"),
    // The RAW (verified) request body, stored as jsonb. The signature was already
    // checked at receive time, so the persisted payload is authentic.
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Processing lifecycle: `received` (awaiting the processor) → `processed`
    // (terminal success) | `failed` (recoverable — the sweeper re-drives) |
    // `dead_lettered` (attempt budget exhausted — loud terminal, human attention).
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("webhook_events_status_check", sql`${table.status} IN ('received','processed','failed','dead_lettered')`),
    index("webhook_events_org_id").on(table.orgId),
    index("webhook_events_source_id").on(table.sourceId),
    // The sweeper's hot read: pull undriven (`received`/`failed`) rows oldest-first.
    index("webhook_events_status").on(table.status),
  ],
);
