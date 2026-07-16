// The `organizations` repository — org-row reads plus the sole org-config CAS
// surface. getLogin remains non-secret identity only; config snapshot/CAS are
// explicit config-write methods (not secret export APIs).

import type pg from "pg";
import {
  type ConfigCasOutcome,
  type ConfigSnapshot,
  configCasImpossibleMiss,
  revisionText,
} from "../config/configRevision.js";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Thrown when `getLogin` is asked for an `orgId` that has no row (or the row
 * is off-scope under RLS for the caller). FAIL-LOUD: deploy-app naming is
 * namespaced by the org slug, so a missing org is a wiring bug (a derive
 * against an orphan org), never a silent un-namespaced default.
 */
export class OrganizationNotFoundError extends Error {
  constructor(orgId: string) {
    super(`organizations: no row for org_id '${orgId}' (or off-scope under RLS)`);
    this.name = "OrganizationNotFoundError";
  }
}

export type OrgConfigSnapshot = ConfigSnapshot;

export const OrganizationsStore = {
  /**
   * Resolve the org's HOSTNAME-SAFE slug (the `login` column). Deploy provisioners
   * use this as the mandatory prefix on every created Fly/Vercel app.
   */
  async getLogin(client: QueryClient, orgId: string, _actor: ActorRef): Promise<string> {
    const result = await client.query<{ login: string }>("SELECT login FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationNotFoundError(orgId);
    }
    return row.login;
  },

  /**
   * Snapshot of org config + application generation. `undefined` when the row is
   * absent or invisible under the client's org RLS scope (foreign ≡ missing).
   */
  async getConfigSnapshot(
    client: QueryClient,
    orgId: string,
    _actor: ActorRef,
  ): Promise<OrgConfigSnapshot | undefined> {
    const result = await client.query<{ config: unknown; revision: unknown }>(
      "SELECT config, config_revision::text AS revision FROM organizations WHERE id = $1",
      [orgId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return { config: row.config, revision: revisionText(row.revision) };
  },

  /**
   * Sole write authority for organizations.config after create INSERT.
   * One revision-predicated UPDATE: bumps only when config is JSONB-distinct.
   * Zero rows → authoritative re-read (not_found / conflict / same-rev no-op ok).
   * Serialization point is the UPDATE; never an unlocked pre-read short-circuit.
   */
  async compareAndSwapConfig(
    client: QueryClient,
    orgId: string,
    expectedRevision: string,
    nextConfig: unknown,
    _actor: ActorRef,
  ): Promise<ConfigCasOutcome> {
    const nextJson = JSON.stringify(nextConfig);
    const result = await client.query<{ config: unknown; revision: unknown }>(
      `UPDATE organizations
          SET config = $1::jsonb,
              config_revision = config_revision + 1,
              updated_at = now()
        WHERE id = $2
          AND config_revision = $3::bigint
          AND config IS DISTINCT FROM $1::jsonb
        RETURNING config, config_revision::text AS revision`,
      [nextJson, orgId, expectedRevision],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return { status: "ok", config: row.config, revision: revisionText(row.revision) };
    }
    const probe = await client.query<{ config: unknown; revision: unknown; config_equal: boolean }>(
      `SELECT config, config_revision::text AS revision,
              (config IS NOT DISTINCT FROM $2::jsonb) AS config_equal
         FROM organizations WHERE id = $1`,
      [orgId, nextJson],
    );
    const after = probe.rows[0];
    if (after === undefined) {
      return { status: "not_found" };
    }
    const rev = revisionText(after.revision);
    if (rev !== expectedRevision) {
      return { status: "conflict", current: { config: after.config, revision: rev } };
    }
    if (after.config_equal) {
      return { status: "ok", config: after.config, revision: rev };
    }
    return configCasImpossibleMiss("organization", orgId, expectedRevision);
  },
} as const;
