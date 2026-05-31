// P3-0003: read/write the per-org GitHub App installation block living in
// `organizations.config.github_app` (JSONB; no dedicated table). Both the
// install-onboarding callback (write) and the token resolver (read) go through
// here so the JSONB round-trip stays in one place and always flows through
// `migrateOrgConfig`.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";

// RLS R3b: the org GitHub-App block lives in `organizations.config`, an
// RLS-enabled table keyed on `id`. These helpers are called from contexts that
// do NOT carry an actor org scope — the public OAuth install `/callback` (org id
// comes from the signed state cookie, not an actor) and the per-run token
// resolver. Each reads/writes a SINGLE, already-known org's own row, so it runs
// under `runWithOrgScope(pool, orgId, …)`: the deny-by-default policy
// (`id = current_setting('app.current_org_id', true)`) then admits exactly that
// org's row on the runtime `tanren_app` role — no BYPASSRLS needed, no policy
// loosened. When an ambient scope is already open (a handler on the scoping
// pool), this opens a nested same-org transaction, which is correct.
export async function loadOrgGithubAppInstallation(
  pool: pg.Pool,
  orgId: string,
): Promise<OrgGithubAppInstallation | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    return row === undefined ? undefined : migrateOrgConfig(row.config).github_app;
  });
}

export async function persistOrgGithubAppInstallation(
  pool: pg.Pool,
  orgId: string,
  installation: OrgGithubAppInstallation,
): Promise<boolean> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    if (row === undefined) {
      return false;
    }
    const next = { ...migrateOrgConfig(row.config), github_app: installation };
    const updated = await client.query<{ id: string }>(
      "UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id",
      [JSON.stringify(next), orgId],
    );
    return updated.rowCount !== null && updated.rowCount > 0;
  });
}
