// P3-0003: read/write the per-org GitHub App installation block living in
// `organizations.config.github_app` (JSONB; no dedicated table). Both the
// install-onboarding callback (write) and the token resolver (read) go through
// here so the JSONB round-trip stays in one place and always flows through
// `migrateOrgConfig`.

import type pg from "pg";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";

export async function loadOrgGithubAppInstallation(
  pool: pg.Pool,
  orgId: string,
): Promise<OrgGithubAppInstallation | undefined> {
  const result = await pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return migrateOrgConfig(row.config).github_app;
}

export async function persistOrgGithubAppInstallation(
  pool: pg.Pool,
  orgId: string,
  installation: OrgGithubAppInstallation,
): Promise<boolean> {
  const result = await pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
  const row = result.rows[0];
  if (row === undefined) {
    return false;
  }
  const next = { ...migrateOrgConfig(row.config), github_app: installation };
  const updated = await pool.query<{ id: string }>(
    "UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id",
    [JSON.stringify(next), orgId],
  );
  return updated.rowCount !== null && updated.rowCount > 0;
}
