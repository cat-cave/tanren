// Tanren-native templating — the template REGISTRY table (wave 1 of N).
//
// A template is a VALIDATED INSTANCE of the stack-flexible contract for a stack:
// a real conforming repo + a `.tanren/template.yml` manifest (parsed +
// persisted here). docs/roadmap/templating-system.md §1. This is the durable
// OBJECT later waves write/read — the validation harness, the creation meta-DAG,
// and template selection. Split into its own schema file (re-exported into the
// single `schema.*` namespace at the bottom of schema.ts) to respect the
// file-line-max-500 architecture rule.
//
// SCOPING — org-scoped with an OFFICIAL/cat-cave shared tier. Every template is
// OWNED by an org (`org_id`); a private org template stays visible only to that
// org under deny-by-default RLS. An OFFICIAL template (status `official`, the
// reviewed cat-cave tier) is owned by the platform org but READABLE cross-org —
// the migration's RLS policy admits a row when `org_id = current_org_id` OR the
// row is `official`, so every org can SEED from the shared catalogue while WRITES
// stay org-scoped (WITH CHECK keeps `org_id = current_org_id`; only a platform
// admin acting in the platform org can author/bless an official template). See
// the templates RLS block in the migration for the exact policy.
//
// STACK-AGNOSTIC: the `manifest` jsonb is the parsed `TemplateManifestV1` whose
// `capabilities` describe ANY stack (incl. a non-code one); no stack is encoded
// in the table. `channel` is mirrored out of the manifest into its own column so
// the maintenance scheduler + selection can filter by channel without parsing
// the jsonb.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    // The owning org. A private org template is visible only to this org under
    // RLS; an `official` template is owned by the platform org but the RLS policy
    // makes it cross-org readable (see the migration's templates policy).
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // Where the template's conforming repo lives — the GitHub repo ref (owner/repo
    // or a clone url) selection seeds a greenfield project FROM. Opaque to Tanren;
    // the validation harness + selection resolve it.
    repoRef: text("repo_ref").notNull(),
    // The parsed `TemplateManifestV1` (manifest.ts), persisted verbatim. The
    // single source of truth for the template's capabilities + validation proof;
    // the columns below are denormalized projections for indexable querying.
    manifest: jsonb("manifest")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Registry lifecycle tier (templating-system.md §1):
    //   draft     — registered, not yet validated (manifest.validationProof null).
    //   validated — the validation harness proved it meaningful (private/org tier).
    //   degraded  — its proof expired or audits found unresolved P0/P1.
    //   official  — the reviewed cat-cave shared tier (cross-org readable).
    status: text("status").notNull().default("draft"),
    // The maintenance channel mirrored from the manifest (`lts` | `nightly`) so
    // the scheduler + selection filter without parsing the jsonb.
    channel: text("channel").notNull().default("lts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("templates_status_check", sql`${table.status} IN ('draft','validated','degraded','official')`),
    check("templates_channel_check", sql`${table.channel} IN ('lts','nightly')`),
    index("templates_org_id").on(table.orgId),
    // Selection + the maintenance scheduler scan by status/channel (the official
    // catalogue read + the per-channel due-template fan-out).
    index("templates_status").on(table.status),
    index("templates_channel").on(table.channel),
  ],
);
