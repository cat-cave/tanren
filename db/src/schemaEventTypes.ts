import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";

// SP-8 event vocabulary. `event_types` is the PLATFORM-GLOBAL catalog of every
// event name the system may persist — deliberately NOT tenant-scoped: it has NO
// `org_id`, NO row-level-security policy, and a single-column PRIMARY KEY on
// `name`. It is the referenced side of the `events.event_type` and
// `notification_routes.event_name` foreign keys (migration 0040). Keeping it
// RLS-free is load-bearing: the referencing tables ARE org-scoped + RLS-forced,
// and Postgres evaluates an FK check against the referenced row WITHOUT the
// writer's row-security context — an RLS-guarded catalog would make every
// tenant's insert fail the FK. The vocabulary is not a secret, so a global,
// unguarded catalog is correct.
//
// The complete current + retained-historical vocabulary is SEEDED in-txn by
// migration 0040 BEFORE the two FKs are added, so the FK never points at an
// empty table. The seed rows mirror db/src/eventTypesSeed.ts, generated from the
// single event vocabulary source (see scripts/generate-event-type-seed.mjs).
export const eventTypes = pgTable(
  "event_types",
  {
    name: text("name").primaryKey(),
    // Default matrix severity for the event (ok | info | warn | fail). Sourced
    // from eventDefaultSeverity for live names; a sensible constant for the
    // retained-historical names that are no longer emitted.
    defaultSeverity: text("default_severity").notNull(),
  },
  (table) => [
    check("event_types_default_severity_check", sql`${table.defaultSeverity} IN ('ok','info','warn','fail')`),
  ],
);
