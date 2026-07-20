// in-7 — the org-scoped INTEGRATION-FRAGMENT REGISTRY (provider-specific
// integration definitions).
//
// The integration derivation/lifecycle phase resolves the provider-specific
// integration DEFINITION a project's requirement needs (capability + provider +
// binding-output kinds + validation plan). A missing definition spawns the F2
// authoring loop (writer→validate, fixed-point convergent, the shared SP-2
// `createAuthoringKernel`) which persists each validated definition here as an
// immutable, org-owned registry row; a failed post-authoring batch compose
// RETRACTS the row (hard delete) so the org's registry stays free of cross-run
// contamination — the same discipline the gv-10 `governance_fragments` and the
// ds-3 `design_fragments` tables use.
//
// TENANCY — `org_id` on every row, `.enableRLS()` (drizzle emits ENABLE + the
// deny-by-default `rls_org_isolation` policy), and the migration hand-appends
// `FORCE ROW LEVEL SECURITY` (mirrors the governance/design fragment tables): a
// query off the scoped client sees ZERO of another tenant's rows even for the
// table owner.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

const sha256Pattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

function integrationFragmentOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", { for: "all", using: predicate, withCheck: predicate });
}

export const integrationFragments = pgTable(
  "integration_fragments",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    capability: text("capability").notNull(),
    providerKind: text("provider_kind").notNull(),
    plane: text("plane").notNull(),
    version: text("version").notNull(),
    body: jsonb("body").notNull(),
    digest: text("digest").notNull(),
    status: text("status").notNull().default("validated"),
    createdBy: text("created_by").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    // The reuse key — one validated definition per (org, capability, provider, version).
    uniqueIndex("integration_fragments_org_cap_provider_version_unique").on(
      table.orgId,
      table.capability,
      table.providerKind,
      table.version,
    ),
    index("integration_fragments_org_id").on(table.orgId),
    check("integration_fragments_status_check", sql`${table.status} = 'validated'`),
    check("integration_fragments_plane_check", sql`${table.plane} IN ('control','product')`),
    check("integration_fragments_digest_check", sql`${table.digest} ~ ${sha256Pattern}`),
    integrationFragmentOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
