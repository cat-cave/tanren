// Org-scoped FRAGMENTS table (docs/roadmap/templating-system.md, F2).
//
// Per-fragment authoring runs persist validated fragments here; the unified
// library loader reads them out and assembles a `bundled core + org-scoped`
// library. Bundled core fragments live in TypeScript under
// `services/orchestrator/src/engine/templates/fragments/library/` (immutable,
// evolved via tanren-monorepo PRs); org-authored fragments live in this table
// and SHADOW a bundled core fragment when they declare the same (kind, label).
//
// SCOPING — strictly org-scoped. There is no cross-org `official` tier here:
// the bundled core IS the cross-org defaults; an org-authored fragment is
// always private to its org. RLS isolates by `org_id`.
//
// The row's `body_ts` field carries the fragment's TypeScript source — a
// default-exported `Fragment` whose `apply()` body uses the constrained-subset
// the unified loader (`unifiedLibrary.ts:interpretOrgFragment`) parses. The
// contract jsonb mirrors the fragment's declared `FragmentContract` so callers
// that don't load the body can still answer "does this fragment declare a
// testRunner?" queries.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

export const fragments = pgTable(
  "fragments",
  {
    // Stable id: `<orgId>:<kind>-<label>:<version>` — encodes the natural key.
    fragmentId: text("fragment_id").primaryKey(),
    // The owning org. Strictly private; no cross-org tier.
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // Which compose phase the fragment fills (`base`, `runtime`, `frontend`,
    // `backend`, `db`, `auth`, `addon`, `example`, `deploy`).
    kind: text("kind").notNull(),
    // The per-kind label (the `<kind>-<label>` id suffix the composer requires).
    label: text("label").notNull(),
    // SemVer version of the fragment body. A re-author bumps this; the unified
    // loader returns the LATEST validated version per (org, kind, label).
    version: text("version").notNull(),
    // The fragment's TypeScript source — a default-exported `Fragment` object
    // whose `apply()` body uses ONLY the constrained-subset operations the
    // unified loader parses.
    bodyTs: text("body_ts").notNull(),
    // The fragment's declared `FragmentContract` mirrored into jsonb (mirrors
    // the engine-side `FragmentContractSchema`). The composer's post-processors
    // read these fields (e.g. `testRunner` for `processCiYml`).
    contract: jsonb("contract").notNull(),
    // The fragment ids this fragment requires; used by the library load-order
    // resolver to topologically order applications within a phase.
    dependsOn: jsonb("depends_on")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Lifecycle tier. `draft` until the authoring run's validate stage passes;
    // then flipped to `validated`. The unified loader returns only `validated`.
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the authoring run's validate stage flips status to `validated`.
    validatedAt: timestamp("validated_at", { withTimezone: true }),
  },
  (table) => [
    check("fragments_status_check", sql`${table.status} IN ('draft','validated')`),
    // The natural key — re-publish the same body to bump the version; the
    // unified loader resolves duplicates by (validated_at desc, version desc).
    uniqueIndex("fragments_org_kind_label_version").on(table.orgId, table.kind, table.label, table.version),
    index("fragments_org_id").on(table.orgId),
    index("fragments_status").on(table.status),
  ],
);
