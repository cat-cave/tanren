// read/write the per-org GitHub App installation block living in
// `organizations.config.github_app` (JSONB; no dedicated table). Both the
// install-onboarding callback (write) and the token resolver (read) go through
// here so the JSONB round-trip stays in one place and always flows through
// `migrateOrgConfig`. Writes use the sole org-config CAS (progress mutate).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { mutateOrgConfig, OrgConfigMissingError } from "../config/orgConfigMutate.js";
import { bindOrgGithubCredentialRefs, migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { systemActor } from "../state/actor.js";
import { canonicalOrgGithubCredentialRef } from "./refNamespace.js";

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
    // Read-only path keeps the historical SELECT shape (no revision token needed).
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    if (row === undefined) return row;
    return bindOrgGithubCredentialRefs(migrateOrgConfig(row.config), orgId).github_app;
  });
}

/**
 * Read the org's configured default GitHub credential ref
 * (`organizations.config.defaultCredentials.github_token`). Pre-run connectivity
 * paths (brownfield link/recon) that have no project-record ref and no App
 * installation resolve their static token from this. Returns undefined when the
 * org sets no default — the caller then has no GitHub credential and the token
 * resolver raises a hard config error (no hardcoded default ref).
 *
 * RLS: same single-org scoping rationale as `loadOrgGithubAppInstallation`.
 */
export async function loadOrgDefaultGithubCredentialRef(pool: pg.Pool, orgId: string): Promise<string | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    if (row === undefined) return row;
    const ref = migrateOrgConfig(row.config).defaultCredentials?.github_token;
    return ref === undefined
      ? undefined
      : canonicalOrgGithubCredentialRef({ orgId, supplied: ref, kind: "github_token" });
  });
}

/**
 * Set the org's default GitHub credential ref via progress-based org config CAS.
 * Returns false when the org row is absent.
 */
export async function persistOrgDefaultGithubCredentialRef(
  pool: pg.Pool,
  orgId: string,
  credentialRef: string,
): Promise<boolean> {
  return runWithOrgScope(pool, orgId, async (client) => {
    try {
      await mutateOrgConfig(client, orgId, systemActor, (raw) => {
        const current = migrateOrgConfig(raw);
        return bindOrgGithubCredentialRefs(
          migrateOrgConfig({
            ...current,
            defaultCredentials: { ...current.defaultCredentials, github_token: credentialRef },
          }),
          orgId,
        );
      });
      return true;
    } catch (error) {
      if (error instanceof OrgConfigMissingError) {
        return false;
      }
      throw error;
    }
  });
}

export async function persistOrgGithubAppInstallation(
  pool: pg.Pool,
  orgId: string,
  installation: OrgGithubAppInstallation,
): Promise<boolean> {
  return runWithOrgScope(pool, orgId, async (client) => {
    try {
      await mutateOrgConfig(client, orgId, systemActor, (raw) => {
        return bindOrgGithubCredentialRefs({ ...migrateOrgConfig(raw), github_app: installation }, orgId);
      });
      return true;
    } catch (error) {
      if (error instanceof OrgConfigMissingError) {
        return false;
      }
      throw error;
    }
  });
}
