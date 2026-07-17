// P3-0022 candidate inbox: the intake mouth of the loop.
//
// Two tables, split from schema.ts to respect the file-line-max-500
// architecture rule (re-exported into the single `schema.*` namespace at the
// bottom of schema.ts so the migration generator + consumers see one space):
//
//   inbox_sources  — CONFIGURABLE source connectors (GitHub Issues, Sentry,
//                    manual, and scheduled audits). External `config` JSONB is
//                    decoded by one strict per-kind persisted schema; it never
//                    carries a reusable credential selector. A source also has
//                    an `on` toggle and an `auto` flag. System sources (auto=true,
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
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    projectId: text("project_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    detail: text("detail").notNull().default(""),
    // Strict per-kind provider-only config (GitHub repo/labels or Sentry query).
    // Credential authority and lifecycle metadata never live in this JSON.
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // `enabled` toggles polling/ingest; `autoRoute` marks a system source whose
    // findings skip manual triage (verdict auto-routable → accepted).
    enabled: text("enabled").notNull().default("true"),
    autoRoute: text("auto_route").notNull().default("false"),
    state: text("state").notNull().default("active"),
    attentionCode: text("attention_code"),
    attentionMessage: text("attention_message"),
    attentionObservedAt: timestamp("attention_observed_at", { withTimezone: true }),
    // Internal-only reusable coordinate. It is never included in source config,
    // HTTP DTOs, or UI models; consumers read it through a narrow repository seam.
    webhookSecretRef: text("webhook_secret_ref"),
    // Provider-directed delay (not an in-process sleep), shared by all pollers.
    retryNotBefore: timestamp("retry_not_before", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("inbox_sources_kind_check", sql`${table.kind} IN ('issues','errors','system','manual','scheduled_audit')`),
    check("inbox_sources_enabled_check", sql`${table.enabled} IN ('true','false')`),
    check("inbox_sources_auto_route_check", sql`${table.autoRoute} IN ('true','false')`),
    check("inbox_sources_state_check", sql`${table.state} IN ('active','needs_attention')`),
    check(
      "inbox_sources_attention_check",
      sql`(
        ${table.state} = 'active'
        AND ${table.attentionCode} IS NULL
        AND ${table.attentionMessage} IS NULL
        AND ${table.attentionObservedAt} IS NULL
      ) OR (
        ${table.state} = 'needs_attention'
        AND ${table.enabled} = 'false'
        AND ${table.attentionCode} IN ('unsupported_provider','invalid_config','credential_unavailable','authority_unavailable','resource_unavailable')
        AND ${table.attentionMessage} IS NOT NULL
        AND ${table.attentionObservedAt} IS NOT NULL
      )`,
    ),
    index("inbox_sources_org_id").on(table.orgId),
    index("inbox_sources_project_id").on(table.projectId),
    index("inbox_sources_retry_not_before").on(table.orgId, table.retryNotBefore),
    uniqueIndex("inbox_sources_org_source_unique").on(table.orgId, table.id),
    foreignKey({
      name: "inbox_sources_project_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
    }),
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
    sourceId: text("source_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id"),
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
    resolvedSpecId: text("resolved_spec_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("candidates_severity_check", sql`${table.severity} IN ('info','warn','fail')`),
    check(
      "candidates_status_check",
      sql`${table.status} IN ('new','triaged','auto_routed','accepted','folded','dismissed','closed_duplicate')`,
    ),
    uniqueIndex("candidates_source_external_unique").on(table.orgId, table.sourceId, table.externalId),
    index("candidates_org_id").on(table.orgId),
    index("candidates_project_id").on(table.projectId),
    index("candidates_status").on(table.status),
    foreignKey({
      name: "candidates_source_org_fk",
      columns: [table.orgId, table.sourceId],
      foreignColumns: [inboxSources.orgId, inboxSources.id],
    }),
    foreignKey({
      name: "candidates_project_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
    }),
    foreignKey({
      name: "candidates_resolved_spec_fk",
      columns: [table.orgId, table.resolvedSpecId],
      foreignColumns: [specs.orgId, specs.specId],
    }),
  ],
);

// §3.6 issue-loop hardening: the DURABLE raw-webhook landing table. The webhook
// receiver PERSISTS the verified delivery here and returns 202 FAST (inside
// GitHub's 10s window); a background processor then does the allocation/triage/
// routing OUT of band. This makes intake never-silently-lost: a processing
// failure leaves the row `failed` (with the captured error + an observability
// attempt count), and the stuck-candidate sweeper re-drives claimable
// `received`/`failed` rows on its interval. A processing claim has an expiry so
// a crashed holder is reclaimable; liveness never depends on an attempt cap.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The provider event name (`issues`) — so the processor dispatches the right
    // mapper, and a sweeper can scope to a kind.
    eventType: text("event_type").notNull(),
    // GitHub's `x-github-delivery` id when present — diagnostics + dedupe aid.
    deliveryId: text("delivery_id"),
    // Provider identity is part of a delivery's durable idempotency key. Existing
    // historical rows remain nullable until their source adapter is upgraded.
    provider: text("provider"),
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
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    canonicalPayloadHash: text("canonical_payload_hash"),
    signatureAlgo: text("signature_algo"),
    signatureKeyVersion: text("signature_key_version"),
    deliverySignedAt: timestamp("delivery_signed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("webhook_events_status_check", sql`${table.status} IN ('received','processed','failed','dead_lettered')`),
    check(
      "webhook_events_claim_check",
      sql`(${table.claimOwner} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimOwner} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`,
    ),
    check(
      "webhook_events_canonical_payload_hash_check",
      sql`${table.canonicalPayloadHash} IS NULL OR ${table.canonicalPayloadHash} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    index("webhook_events_org_id").on(table.orgId),
    index("webhook_events_source_id").on(table.sourceId),
    // The sweeper's hot read: pull undriven (`received`/`failed`) rows oldest-first.
    index("webhook_events_status").on(table.status),
    uniqueIndex("webhook_events_provider_delivery_unique")
      .on(table.orgId, table.sourceId, table.provider, table.deliveryId)
      .where(sql`${table.deliveryId} IS NOT NULL`),
    foreignKey({
      name: "webhook_events_source_org_fk",
      columns: [table.orgId, table.sourceId],
      foreignColumns: [inboxSources.orgId, inboxSources.id],
    }),
  ],
);
