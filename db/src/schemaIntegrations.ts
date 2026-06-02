// Integration-provisioning foundation (P-INT-0 + P-APP-ENV-0): the two new
// surfaces the boundary model in docs/operator-guide/integration-provisioning.md
// stands on, split from schema.ts to respect the file-line-max-500 architecture
// rule (re-exported into the single `schema.*` namespace at the bottom of
// schema.ts so the migration generator + consumers see one space).
//
//   org_integrations  — PLANE A. One row per (org, provider_kind): the managed
//                       credential ref for the org-level grant, NON-SECRET org
//                       metadata (Sentry org slug, Slack workspace id, …), the
//                       enabled capability ids, and a provisioning status. This
//                       is the single place onboarding reads to know "does this
//                       org have Sentry?" and to resolve the grant the
//                       IntegrationProvisioner port runs under. The secret VALUE
//                       never lives here — only the manager REF (`credential_ref`).
//
//   project_app_env   — PLANE B. The built PRODUCT's own env vars + secrets,
//                       per project, DISTINCT from org_integrations (which holds
//                       Tanren's own integrations). One row per (project, key):
//                       exactly one of `value_ref` (secret-manager ref) or
//                       `plain_value` (non-secret config) is set (CHECK); the
//                       `scopes` subset of {build,test,runtime,dev} controls which
//                       phase the value reaches; `source` records byo vs.
//                       provisioned. Secret values live only in the secret
//                       manager — `value_ref` points at them, never the value.
//
// Both tables are deny-by-default RLS (added in the migration, not the schema):
// org_integrations keys directly on org_id (3a-style direct policy);
// project_app_env scopes through its project's org (3c-style project→org EXISTS
// chain). See migration 0051's RLS block.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

// Provisioning lifecycle of an org-level integration grant. `linked` is the
// resting state (a usable grant); `provisioning` while a long-running org-level
// setup is mid-flight; `error` when the last grant operation failed.
const ORG_INTEGRATION_STATUSES = ["linked", "provisioning", "error"] as const;

export const orgIntegrations = pgTable(
  "org_integrations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The provider this grant is for (sentry | slack | deploy.vercel | …). One
    // grant per provider per org — the unique index below enforces it.
    providerKind: text("provider_kind").notNull(),
    // The secret-manager REF for the org-level credential (token / app key). The
    // secret VALUE is never stored here — only the ref the SecretStore resolves.
    credentialRef: text("credential_ref").notNull(),
    // NON-SECRET org metadata the provisioner needs (sentry org slug, slack
    // workspace id, hetzner project, vercel team). No secret values here.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The enabled capability ids for this grant (e.g. ["errors"], ["notify"]).
    capabilities: jsonb("capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("linked"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("org_integrations_status_check", sql`${table.status} IN ('linked','provisioning','error')`),
    uniqueIndex("org_integrations_org_provider_unique").on(table.orgId, table.providerKind),
    index("org_integrations_org_id").on(table.orgId),
  ],
);

// Which phases an app-env entry reaches. The resolver materializes an entry only
// for the phase(s) named here — a `dev`-only entry never reaches CI/runtime.
const APP_ENV_SCOPES = ["build", "test", "runtime", "dev"] as const;

// How the entry's value was supplied: `byo` = the operator added it; `provisioned`
// = an IntegrationProvisioner created the app's resource and emitted its secret.
const APP_ENV_SOURCES = ["byo", "provisioned"] as const;

export const projectAppEnv = pgTable(
  "project_app_env",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    key: text("key").notNull(),
    // EXACTLY ONE of value_ref / plain_value is set (CHECK below). `value_ref` is
    // a secret-manager ref (the secret VALUE lives in the manager, never here);
    // `plain_value` is non-secret config materialized inline.
    valueRef: text("value_ref"),
    plainValue: text("plain_value"),
    // Subset of {build,test,runtime,dev} controlling which phase the value
    // reaches. Stored as a text[] so the resolver can filter by phase membership.
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    source: text("source").notNull().default("byo"),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("project_app_env_source_check", sql`${table.source} IN ('byo','provisioned')`),
    // Exactly one of value_ref / plain_value: a secret ref XOR an inline plain
    // value. Neither-set or both-set is rejected at the DB.
    check(
      "project_app_env_value_xor_check",
      sql`(${table.valueRef} IS NOT NULL AND ${table.plainValue} IS NULL) OR (${table.valueRef} IS NULL AND ${table.plainValue} IS NOT NULL)`,
    ),
    uniqueIndex("project_app_env_project_key_unique").on(table.projectId, table.key),
    index("project_app_env_project_id").on(table.projectId),
  ],
);

// Runtime literal lists, exported for the orchestrator engine to validate
// against without re-declaring the unions.
export const orgIntegrationStatuses = ORG_INTEGRATION_STATUSES;
export const appEnvScopes = APP_ENV_SCOPES;
export const appEnvSources = APP_ENV_SOURCES;
