import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgPolicy } from "drizzle-orm/pg-core";

/** Drizzle-owned deny-by-default tenant policy for every integration table. */
export function integrationOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", {
    for: "all",
    using: predicate,
    withCheck: predicate,
  });
}
