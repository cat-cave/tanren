// Progress-based internal RMW for organizations.config. Thin consumer of the
// sole OrganizationsStore snapshot/CAS primitive — never a second write authority.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { OrganizationsStore } from "../repositories/organizations.js";
import type { ConfigRevision } from "./configRevision.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Thrown when the org row is absent (or invisible under RLS) mid-mutate. */
export class OrgConfigMissingError extends Error {
  constructor(public readonly orgId: string) {
    super(`org config missing for org_id '${orgId}' (absent or off-scope under RLS)`);
    this.name = "OrgConfigMissingError";
  }
}

/**
 * Apply a pure merge against the current org config until the CAS wins.
 * No fixed attempt cap. Terminates on success or typed missing-org error.
 * Semantic no-ops go through store CAS (revision-predicated, no unlocked skip).
 */
export async function mutateOrgConfig<T>(
  client: QueryClient,
  orgId: string,
  actor: ActorRef,
  mutate: (current: unknown) => T,
): Promise<{ value: T; config: unknown; revision: ConfigRevision }> {
  for (;;) {
    const snapshot = await OrganizationsStore.getConfigSnapshot(client, orgId, actor);
    if (snapshot === undefined) {
      throw new OrgConfigMissingError(orgId);
    }
    const value = mutate(snapshot.config);
    const nextConfig: unknown = value;
    const outcome = await OrganizationsStore.compareAndSwapConfig(client, orgId, snapshot.revision, nextConfig, actor);
    if (outcome.status === "ok") {
      return { value, config: outcome.config, revision: outcome.revision };
    }
    if (outcome.status === "not_found") {
      throw new OrgConfigMissingError(orgId);
    }
  }
}
