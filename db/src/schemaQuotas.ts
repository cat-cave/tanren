// Per-org quota/balance store (SaaS Tier-B quota-admission-gate). This is the
// ENFORCEMENT half of the OSS↔hosting billing boundary: the OSS repo defines
// the table + enforces whatever limits are present; a closed hosting layer
// writes the limits and resets the window. A self-hosted deployment that never
// writes a row here is unrestricted (the DB-backed policy treats "no row" as
// unlimited), so default behavior is unchanged.
//
// One row per (org_id, window_key): `window_key` is the hosting layer's opaque
// label for the active billing window (e.g. "2026-05" or a UUID). The OSS does
// NOT compute windows or roll them over — it reads the limits and accrues the
// `used_*` counters as runs complete. `reset_at` is advisory metadata the
// hosting layer stamps; the OSS never auto-resets.
//
// Limits are NULLABLE: a NULL limit field means "no ceiling on this dimension"
// so the hosting layer can cap runs, tokens, credits independently or leave any
// dimension unlimited. See docs/architecture/portability-and-longevity.md
// (OSS↔hosting seam).

import { sql } from "drizzle-orm";
import { bigint, index, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

export const orgQuotas = pgTable(
  "org_quotas",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // Opaque hosting-layer label for the active window. Self-hosters never set
    // a row; the hosting layer owns window semantics + rollover.
    windowKey: text("window_key").notNull().default("default"),
    // Per-dimension ceilings. NULL = unlimited on that dimension. The
    // admission gate denies only when a present limit would be exceeded.
    runLimit: bigint("run_limit", { mode: "number" }),
    tokenLimit: bigint("token_limit", { mode: "number" }),
    creditLimit: numeric("credit_limit", { precision: 20, scale: 6 }),
    // Consumed counters, accrued by the OSS from completed runs' cost_records.
    runsUsed: bigint("runs_used", { mode: "number" }).notNull().default(0),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    creditsUsed: numeric("credits_used", { precision: 20, scale: 6 })
      .notNull()
      .default(sql`0`),
    // Advisory reset metadata stamped by the hosting layer; the OSS never
    // auto-resets — it only reads/accrues.
    resetAt: timestamp("reset_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_quotas_org_window_unique").on(table.orgId, table.windowKey),
    index("org_quotas_org_id").on(table.orgId),
  ],
);
