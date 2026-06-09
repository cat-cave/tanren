import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { eventTypeNames } from "./eventTypes.js";
import { organizations, users } from "./schemaCore.js";

// P2A-0017 notifications matrix. Split from schema.ts to keep that file
// inside the file-line-max-500 architecture rule. The two tables are the
// persistent backbone for the per-event × per-channel × severity matrix.
// The existing Phase 1 `notifications` table (still in schema.ts) stays as
// the dispatch ledger. See docs/operator-guide/notifications.md.

function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
  const literals = sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(","));
  return check(name, sql`${column} IN (${literals})`);
}

const NOTIFICATION_CHANNEL_KINDS = [
  "ntfy",
  "slack",
  "github_checks",
  "teams",
  "discord",
  "email",
  "twilio",
  "pagerduty",
  "webhook",
] as const;
const NOTIFICATION_SEVERITIES = ["ok", "info", "warn", "fail"] as const;

export const notificationTargets = pgTable(
  "notification_targets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    scope: text("scope").notNull(),
    userId: text("user_id").references(() => users.id),
    channelKind: text("channel_kind").notNull(),
    destination: text("destination").notNull(),
    // Per-target base URL — authoritative per-org host override for channels
    // (ntfy) that resolve a bare-topic destination against a base. NULL means
    // "use the deploy default injected at boot"; a process-wide env base URL
    // must NEVER shadow this (audit C4 / RC-1: a SaaS-host env would otherwise
    // route every tenant's ntfy traffic through one shared host). Only stored
    // when set, and constrained to an http(s) URL shape.
    baseUrl: text("base_url"),
    label: text("label").notNull(),
    enabled: integer("enabled").notNull().default(1),
    weekendMute: integer("weekend_mute").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    enumCheck("notification_targets_channel_kind_check", table.channelKind, NOTIFICATION_CHANNEL_KINDS),
    enumCheck("notification_targets_scope_check", table.scope, ["org", "user"]),
    check(
      "notification_targets_scope_user_check",
      sql`(${table.scope} = 'org' AND ${table.userId} IS NULL) OR (${table.scope} = 'user' AND ${table.userId} IS NOT NULL)`,
    ),
    check("notification_targets_enabled_check", sql`${table.enabled} IN (0,1)`),
    check("notification_targets_weekend_mute_check", sql`${table.weekendMute} IN (0,1)`),
    // base_url, when set, must be an http(s) URL — never a bare host or a
    // non-URL string (fail-loud at write rather than route to a wrong host).
    check("notification_targets_base_url_check", sql`${table.baseUrl} IS NULL OR ${table.baseUrl} ~ '^https?://'`),
    index("notification_targets_org_id").on(table.orgId),
    index("notification_targets_user_id").on(table.userId),
    index("notification_targets_channel_kind").on(table.channelKind),
    // P-INT-2 onboarding-provisioner idempotency backstop: at most ONE org-scoped
    // target per (org, channel_kind, destination). PARTIAL — scoped to
    // `scope='org' AND user_id IS NULL`, exactly the shape the provisioning engine
    // writes — so user-scoped targets (which may legitimately share a destination
    // with the org default) stay unconstrained; only re-onboards dedupe.
    uniqueIndex("notification_targets_provisioned_unique")
      .on(table.orgId, table.channelKind, table.destination)
      .where(sql`${table.scope} = 'org' AND ${table.userId} IS NULL`),
  ],
);

export const notificationRoutes = pgTable(
  "notification_routes",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id")
      .notNull()
      .references(() => notificationTargets.id),
    eventName: text("event_name").notNull(),
    enabled: integer("enabled").notNull().default(1),
    minSeverity: text("min_severity").notNull().default("info"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    enumCheck("notification_routes_min_severity_check", table.minSeverity, NOTIFICATION_SEVERITIES),
    enumCheck("notification_routes_event_name_check", table.eventName, eventTypeNames),
    check("notification_routes_enabled_check", sql`${table.enabled} IN (0,1)`),
    uniqueIndex("notification_routes_target_event_unique").on(table.targetId, table.eventName),
    index("notification_routes_event_name").on(table.eventName),
  ],
);
