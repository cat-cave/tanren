import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { specs } from "./schemaCore.js";

// spec_dependencies: additive m:n DAG edges between specs. Split out of schema.ts
// to hold the file under the file-line-max-500 cap; re-exported as
// `schema.specDependencies`. Only depends on `specs` (schemaCore), so no cycle.
export const specDependencies = pgTable(
  "spec_dependencies",
  {
    fromSpecId: text("from_spec_id")
      .notNull()
      .references(() => specs.specId),
    toSpecId: text("to_spec_id")
      .notNull()
      .references(() => specs.specId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.fromSpecId, table.toSpecId] }),
    check("spec_dependencies_no_self_loop", sql`${table.fromSpecId} <> ${table.toSpecId}`),
    index("spec_dependencies_to_spec_id").on(table.toSpecId),
  ],
);
