// The `organizations` repository — the small set of org-row reads other
// engine sites need, pulled onto the `Repositories` seam (mirrors the
// `ProjectStore` / `IntegrationConnectionsStore` shape). Today this exposes the
// `getLogin(orgId)` slug lookup the deploy provisioners need to namespace
// every deploy-app name with the org's slug (see `flyDeployProvisioner.ts` +
// `vercelDeployProvisioner.ts` — the global-namespace collision fix). Other
// org reads (config, display name) remain inline at their use sites until
// they too move onto the seam.
//
// SECRET DISCIPLINE: this store never reads or returns the org's `config`
// jsonb (which carries managed-credential pointers) — only the non-secret
// identity columns. The org slug (the lowercase, hostname-safe `login`) is
// itself non-secret — it already surfaces in operator-visible org URLs.

import { z } from "zod";
import type { IntegrationQueryClient } from "./integrationQuery.js";
import type { ActorRef } from "../state/actor.js";

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

export const OrganizationsStore = {
  /**
   * Resolve the org's HOSTNAME-SAFE slug (the `login` column — already
   * lowercase, dash-friendly, and unique per (kind, external_id) via the
   * identity-store upsert path). The deploy provisioners use this as the
   * MANDATORY PREFIX on every created Fly/Vercel app — Fly app names live in
   * a GLOBAL namespace across all Fly customers, so a bare project name like
   * `linkly` collides on common words; prefixing with the org's slug makes
   * collisions within an org structurally impossible. FAIL-LOUD on a missing
   * org (never a silent un-namespaced fallback).
   */
  async getLogin(client: IntegrationQueryClient, orgId: string, _actor: ActorRef): Promise<string> {
    const result = await client.query("SELECT login FROM organizations WHERE id = $1", [orgId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationNotFoundError(orgId);
    }
    return z.object({ login: z.string() }).parse(row).login;
  },
} as const;
